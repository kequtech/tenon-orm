import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Transaction } from '../src/index.js';
import { createTenon, sql, unsafeSql } from '../src/index.js';
import { mockDriver, result } from './helpers/driver.js';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test('queries reject direct transaction boundaries before dispatch on root and callback clients', async (t) => {
  const commands = [
    'BEGIN',
    'begin work',
    'START TRANSACTION',
    'COMMIT',
    'COMMIT AND CHAIN',
    "COMMIT PREPARED 'name'",
    'END TRANSACTION',
    'ABORT WORK',
    'ROLLBACK',
    "PREPARE TRANSACTION 'name'",
    '; -- comment\nCOMMIT;',
  ];
  const statements: string[] = [];
  const driver = mockDriver(t, async (text) => {
    statements.push(text);
    return result(text);
  });
  const db = createTenon({ connection: driver.sql });
  const check = async (client: Transaction) => {
    for (const text of commands)
      await assert.rejects(client.query(unsafeSql(text, [])), /cannot start or end a transaction/);
  };
  await check(db);
  await db.transaction(check);
  assert.deepEqual(statements, ['BEGIN', 'COMMIT']);
  assert.equal(driver.release.mock.callCount(), 1);
  await db.close();
});

for (const boundary of ['COMMIT', 'ROLLBACK'] as const) {
  test(`callback scope expires while ${boundary} is pending`, async (t) => {
    const entered = gate(),
      finish = gate();
    const failure = new Error('callback failed');
    const statements: string[] = [];
    const driver = mockDriver(t, async (text) => {
      statements.push(text);
      if (text === boundary) {
        entered.open();
        await finish.promise;
      }
      return result(text);
    });
    const db = createTenon({ connection: driver.sql });
    let expired!: Transaction;
    const pending = db.transaction(async (tx) => {
      expired = tx;
      if (boundary === 'ROLLBACK') throw failure;
      return 'saved';
    });
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await entered.promise;
    try {
      await assert.rejects(expired.query(sql`SELECT 1`), /transaction has finished/);
      assert.equal(driver.release.mock.callCount(), 0);
      assert.deepEqual(statements, ['BEGIN', boundary]);
    } finally {
      finish.open();
    }
    assert.deepEqual(
      await outcome,
      boundary === 'COMMIT' ? { value: 'saved' } : { error: failure },
    );
    assert.equal(driver.release.mock.callCount(), 1);
    await db.close();
  });
}

test('failed commit preserves the original error and rolls back before release', async (t) => {
  const failure = new Error('commit failed');
  const statements: string[] = [];
  const driver = mockDriver(t, async (text) => {
    statements.push(text);
    if (text === 'COMMIT') throw failure;
    return result(text);
  });
  const db = createTenon({ connection: driver.sql });
  await assert.rejects(
    db.transaction(async () => 'saved'),
    (error) => error === failure,
  );
  assert.deepEqual(statements, ['BEGIN', 'COMMIT', 'ROLLBACK']);
  assert.equal(driver.release.mock.callCount(), 1);
  await db.close();
});

test('failed BEGIN discards the reservation without running application work', async (t) => {
  const failure = new Error('BEGIN failed');
  const driver = mockDriver(t, async (text) => {
    if (text === 'BEGIN') throw failure;
    return result(text);
  });
  const db = createTenon({ connection: driver.sql });
  const work = t.mock.fn(async () => 'must not run');
  await assert.rejects(db.transaction(work), (error) => error === failure);
  assert.equal(work.mock.callCount(), 0);
  assert.equal(driver.discard.mock.callCount(), 1);
  assert.equal(driver.release.mock.callCount(), 0);
  await db.close();
});

test('work and rollback failures retain both errors and discard the session', async (t) => {
  const failure = new Error('work failed'),
    rollback = new Error('rollback failed');
  const driver = mockDriver(t, async (text) => {
    if (text === 'ROLLBACK') throw rollback;
    return result(text);
  });
  const db = createTenon({ connection: driver.sql });
  await assert.rejects(
    db.transaction(async () => {
      throw failure;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure, rollback]);
      return true;
    },
  );
  assert.equal(driver.discard.mock.callCount(), 1);
  assert.equal(driver.release.mock.callCount(), 0);
  await db.close();
});

test('failed savepoint recovery prevents a caught failure from committing', async (t) => {
  const recovery = new Error('savepoint recovery failed');
  const statements: string[] = [];
  const driver = mockDriver(t, async (text) => {
    statements.push(text);
    if (text.startsWith('ROLLBACK TO')) throw recovery;
    return result(text.startsWith('UPDATE') ? 'UPDATE' : text, text.startsWith('UPDATE') ? 2 : 0);
  });
  const db = createTenon({ connection: driver.sql });
  await assert.rejects(
    db.transaction(async (tx) => {
      await assert.rejects(tx.query(sql`UPDATE items SET value=1`, { affectedRows: { max: 1 } }));
      await assert.rejects(tx.query(sql`SELECT 1`), /recovery failed/);
      return 'must not commit';
    }),
    /recovery failed/,
  );
  assert.ok(!statements.includes('COMMIT'));
  assert.equal(statements.at(-1), 'ROLLBACK');
  await db.close();
});

test('transaction waits for accepted pending operations before rollback and release', async (t) => {
  const entered = gate(),
    finish = gate();
  const statements: string[] = [];
  const driver = mockDriver(t, async (text) => {
    statements.push(text);
    if (text === 'SELECT 1') {
      entered.open();
      await finish.promise;
    }
    return result(text);
  });
  const db = createTenon({ connection: driver.sql });
  const failure = new Error('callback failed');
  let operation!: Promise<unknown>;
  const pending = db.transaction(async (tx) => {
    operation = tx.query(sql`SELECT 1`);
    await entered.promise;
    throw failure;
  });
  const checked = assert.rejects(pending, (error) => error === failure);
  await entered.promise;
  assert.equal(driver.release.mock.callCount(), 0);
  finish.open();
  await checked;
  await operation;
  assert.deepEqual(statements, ['BEGIN', 'SELECT 1', 'ROLLBACK']);
  await db.close();
});
