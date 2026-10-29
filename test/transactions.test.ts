import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Transaction as NativeTransaction } from '@kequtech/pgclear';
import type { Transaction } from '../src/index.js';
import { createTenon, sql, unsafeSql } from '../src/index.js';
import { mockDriver, result } from './helpers/driver.js';
const gate = () => Promise.withResolvers<void>();

test('queries reject direct transaction boundaries before dispatch on root and callback clients', async (t) => {
  const statements: string[] = [];
  const driver = mockDriver(t, async (text) => {
    statements.push(text);
    return result(text);
  });
  const db = createTenon({ connection: driver.sql });
  const check = async (client: Transaction) => {
    for (const text of [
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
    ])
      await assert.rejects(client.query(unsafeSql(text, [])), /cannot start or end a transaction/);
  };
  await check(db);
  await db.transaction(check);
  assert.deepEqual(statements, []);
  await db.close();
});

for (const boundary of ['COMMIT', 'ROLLBACK'])
  test(`callback scope expires while driver ${boundary} is pending`, async (t) => {
    const entered = gate(),
      finish = gate(),
      failure = new Error('work');
    const driver = mockDriver(t);
    t.mock.method(
      driver.sql,
      'transaction',
      async <T>(work: (tx: NativeTransaction) => Promise<T>) => {
        let value: T | undefined,
          error: unknown,
          failed = false;
        try {
          value = await work(driver.transaction);
        } catch (cause) {
          failed = true;
          error = cause;
        }
        entered.resolve();
        await finish.promise;
        if (failed) throw error;
        return value as T;
      },
    );
    const db = createTenon({ connection: driver.sql });
    let escaped!: Transaction;
    const pending = db.transaction(async (tx) => {
      escaped = tx;
      if (boundary === 'ROLLBACK') throw failure;
      return 'saved';
    });
    const outcome = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    try {
      await assert.rejects(escaped.query(sql`SELECT 1`), /transaction has finished/);
    } finally {
      finish.resolve();
    }
    assert.deepEqual(
      await outcome,
      boundary === 'COMMIT' ? { value: 'saved' } : { error: failure },
    );
    await db.close();
  });

test('driver commit failures propagate without Tenon retry or recovery SQL', async (t) => {
  const failure = new Error('commit failed'),
    statements: string[] = [];
  const driver = mockDriver(t, async (text) => {
    statements.push(text);
    return result(text);
  });
  let calls = 0;
  t.mock.method(
    driver.sql,
    'transaction',
    async <T>(work: (tx: NativeTransaction) => Promise<T>) => {
      calls++;
      await work(driver.transaction);
      throw failure;
    },
  );
  const db = createTenon({ connection: driver.sql });
  await assert.rejects(
    db.transaction(async () => 'saved'),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  assert.deepEqual(statements, []);
  await db.close();
});

test('failed driver BEGIN prevents application work without Tenon recovery SQL', async (t) => {
  const failure = new Error('BEGIN failed');
  const driver = mockDriver(t);
  const work = t.mock.fn(async () => 'must not run');
  t.mock.method(driver.sql, 'transaction', async () => {
    throw failure;
  });
  const db = createTenon({ connection: driver.sql });
  await assert.rejects(db.transaction(work), (error) => error === failure);
  assert.equal(work.mock.callCount(), 0);
  await db.close();
});

test('combined driver work and rollback failures retain their identity', async (t) => {
  const failure = new Error('work'),
    rollback = new Error('rollback'),
    combined = new AggregateError([failure, rollback]);
  const driver = mockDriver(t);
  t.mock.method(
    driver.sql,
    'transaction',
    async <T>(work: (tx: NativeTransaction) => Promise<T>) => {
      try {
        return await work(driver.transaction);
      } catch (error) {
        assert.equal(error, failure);
        throw combined;
      }
    },
  );
  const db = createTenon({ connection: driver.sql });
  await assert.rejects(
    db.transaction(async () => {
      throw failure;
    }),
    (error) => error === combined,
  );
  await db.close();
});

test('driver savepoint recovery failures remain failures when application code catches the query error', async (t) => {
  const recovery = new Error('savepoint recovery failed');
  const driver = mockDriver(t, async () => result('UPDATE', 2));
  let poisoned = false;
  t.mock.method(driver.transaction, 'savepoint', async () => {
    poisoned = true;
    throw recovery;
  });
  t.mock.method(driver.transaction, 'queryClassic', async () => {
    throw recovery;
  });
  t.mock.method(
    driver.sql,
    'transaction',
    async <T>(work: (tx: NativeTransaction) => Promise<T>) => {
      const value = await work(driver.transaction);
      if (poisoned) throw recovery;
      return value;
    },
  );
  const db = createTenon({ connection: driver.sql });
  await assert.rejects(
    db.transaction(async (tx) => {
      await assert.rejects(tx.query(sql`UPDATE items SET value=1`, { affectedRows: { max: 1 } }));
      await assert.rejects(tx.query(sql`SELECT 1`), (error) => error === recovery);
      return 'must not commit';
    }),
    (error) => error === recovery,
  );
  await db.close();
});

test('transaction drains accepted operations before returning a callback failure to its driver', async (t) => {
  const entered = gate(),
    finish = gate(),
    failure = new Error('work');
  const driver = mockDriver(t, async (text) => {
    entered.resolve();
    await finish.promise;
    return result(text);
  });
  const db = createTenon({ connection: driver.sql });
  let settled = false;
  let operation!: Promise<unknown>;
  const pending = db.transaction(async (tx) => {
    operation = tx.query(sql`SELECT 1`);
    await entered.promise;
    throw failure;
  });
  const failed = assert
    .rejects(pending, (error) => error === failure)
    .then(() => {
      settled = true;
    });
  await entered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finish.resolve();
  await operation;
  await failed;
  await db.close();
});
