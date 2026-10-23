import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import type { Transaction } from '../src/index.js';
import { createTenon, defineOperation, sql, unsafeSql } from '../src/index.js';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
const operations = { ping: defineOperation(() => sql`SELECT 1`, { returns: 'native' }) };

test('query and run reject direct transaction boundaries before dispatch on root and callback clients', async (t) => {
  const commands = [
    'BEGIN',
    'begin work',
    'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    'START /* nested /* comment */ done */ TRANSACTION',
    'COMMIT',
    'COMMIT WORK AND CHAIN',
    "COMMIT PREPARED 'name'",
    'END TRANSACTION',
    'ABORT WORK',
    'ROLLBACK',
    'ROLLBACK WORK AND CHAIN',
    "ROLLBACK PREPARED 'name'",
    "PREPARE /* comment */ TRANSACTION 'name'",
    '; ; -- leading comment\r/* nested /* BEGIN */ comment */ cOmMiT;',
  ];
  const definitions = Object.fromEntries(
    commands.map((sql, i) => [`boundary_${i}`, defineOperation(() => unsafeSql(sql, []))]),
  );
  const pool = new Pool();
  const rootQuery = t.mock.method(pool, 'query', async () => {
    throw new Error('Public SQL reached the pool');
  });
  const clientQuery = t.mock.fn(async (sql: string) => ({
    command: sql,
    rows: [],
    fields: [],
    rowCount: null,
    oid: 0,
  }));
  const release = t.mock.fn();
  t.mock.method(
    pool,
    'connect',
    async () =>
      Object.assign(new EventEmitter(), { query: clientQuery, release }) as unknown as PoolClient,
  );
  const db = createTenon({ connection: pool });
  async function check(client: Transaction) {
    for (const [i, sql] of commands.entries()) {
      await assert.rejects(client.query(unsafeSql(sql, [])), {
        name: 'Error',
        message: /Query cannot start or end a transaction/,
      });
      await assert.rejects(client.run(definitions[`boundary_${i}`]!, []), {
        name: 'Error',
        message: /Query cannot start or end a transaction/,
      });
    }
  }
  try {
    await check(db);
    await db.transaction(check);
    assert.equal(rootQuery.mock.callCount(), 0);
    assert.deepEqual(
      clientQuery.mock.calls.map((call) => call.arguments[0]),
      ['BEGIN', 'COMMIT'],
    );
    assert.equal(release.mock.callCount(), 1);
  } finally {
    await db.close();
    await pool.end();
  }
});

for (const boundary of ['COMMIT', 'ROLLBACK'] as const) {
  test(`callback scope expires while ${boundary} is pending, before returning its outcome`, async (t) => {
    const pool = new Pool();
    const entered = gate();
    const finish = gate();
    const failure = new Error('callback failed');
    const statements: string[] = [];
    const release = t.mock.fn();
    const client = Object.assign(new EventEmitter(), {
      async query(command: string) {
        statements.push(command);
        if (command === boundary) {
          entered.open();
          await finish.promise;
        }
        return { command, rows: [], fields: [], rowCount: null, oid: 0 };
      },
      release,
    }) as unknown as PoolClient;
    t.mock.method(pool, 'connect', async () => client);
    const db = createTenon({ connection: pool });
    let expired!: Transaction;
    let settled = false;
    const pending = db.transaction(async (tx) => {
      expired = tx;
      if (boundary === 'ROLLBACK') throw failure;
      return { saved: true };
    });
    const outcome = pending.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await entered.promise;
      assert.equal(settled, false);
      assert.equal(release.mock.callCount(), 0);
      await assert.rejects(
        expired.query(sql`SELECT 1`, { returns: 'many' }),
        /transaction has finished/,
      );
      await assert.rejects(expired.run(operations.ping, []), /transaction has finished/);
      assert.deepEqual(statements, ['BEGIN', boundary]);
      finish.open();
      assert.deepEqual(
        await outcome,
        boundary === 'COMMIT' ? { value: { saved: true } } : { error: failure },
      );
      assert.equal(release.mock.callCount(), 1);
    } finally {
      finish.open();
      await outcome;
      await db.close();
      await pool.end();
    }
  });
}

test('a failed commit preserves the native error and releases the connection after rollback', async (t) => {
  const failure = new Error('commit connection failure');
  const pool = new Pool();
  const release = t.mock.fn();
  const statements: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    async query(command: string) {
      statements.push(command);
      if (command === 'COMMIT') throw failure;
      return { command, rows: [], fields: [], rowCount: null, oid: 0 };
    },
    release,
  }) as unknown as PoolClient;
  t.mock.method(pool, 'connect', async () => client);
  const db = createTenon({ connection: pool });

  try {
    await assert.rejects(
      db.transaction(async () => 'saved'),
      (error) => error === failure,
    );
    assert.deepEqual(statements, ['BEGIN', 'COMMIT', 'ROLLBACK']);
    assert.equal(release.mock.callCount(), 1);
    assert.deepEqual(release.mock.calls[0]!.arguments, [undefined]);
  } finally {
    await db.close();
    await pool.end();
  }
});

test('a failed transaction and rollback retain both errors and discard the connection', async (t) => {
  const failure = new Error('callback failed');
  const rollback = new Error('rollback connection failure');
  const pool = new Pool();
  const release = t.mock.fn();
  const client = Object.assign(new EventEmitter(), {
    async query(command: string) {
      if (command === 'ROLLBACK') throw rollback;
      return { command, rows: [], fields: [], rowCount: null, oid: 0 };
    },
    release,
  }) as unknown as PoolClient;
  t.mock.method(pool, 'connect', async () => client);
  const db = createTenon({ connection: pool });

  try {
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
    assert.equal(release.mock.callCount(), 1);
    assert.deepEqual(release.mock.calls[0]!.arguments, [rollback]);
  } finally {
    await db.close();
    await pool.end();
  }
});

test('failed savepoint recovery poisons a transaction even if the callback catches the error', async (t) => {
  const pool = new Pool();
  const recovery = new Error('savepoint recovery failed');
  const statements: string[] = [];
  const release = t.mock.fn();
  const client = Object.assign(new EventEmitter(), {
    async query(query: string | { text: string }) {
      const text = typeof query === 'string' ? query : query.text;
      statements.push(text);
      if (text.startsWith('ROLLBACK TO SAVEPOINT')) throw recovery;
      return {
        command: text.startsWith('UPDATE') ? 'UPDATE' : text,
        rows: [],
        fields: [],
        rowCount: text.startsWith('UPDATE') ? 2 : null,
        oid: 0,
      };
    },
    release,
  }) as unknown as PoolClient;
  t.mock.method(pool, 'connect', async () => client);
  const db = createTenon({ connection: pool });
  try {
    await assert.rejects(
      db.transaction(async (tx) => {
        await assert.rejects(
          tx.query(sql`UPDATE items SET active = false`, {
            affectedRows: { max: 1 },
          }),
          (error) => {
            assert.ok(error instanceof AggregateError);
            assert.match(String(error.errors[0]), /reported 2/);
            assert.equal(error.errors[1], recovery);
            return true;
          },
        );
        await assert.rejects(
          tx.query(sql`INSERT INTO items DEFAULT VALUES`),
          /savepoint recovery failed/,
        );
        return 'must not commit';
      }),
      /savepoint recovery failed/,
    );
    assert.equal(statements.includes('COMMIT'), false);
    assert.equal(
      statements.some((s) => s.startsWith('INSERT')),
      false,
    );
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.equal(release.mock.callCount(), 1);
  } finally {
    await db.close();
    await pool.end();
  }
});

test('transaction rollback waits for pending operations before releasing the connection', async (t) => {
  const pool = new Pool();
  const entered = gate();
  const finish = gate();
  const statements: string[] = [];
  const release = t.mock.fn();
  const client = Object.assign(new EventEmitter(), {
    async query(query: string | { text: string }) {
      const text = typeof query === 'string' ? query : query.text;
      statements.push(text);
      if (text.startsWith('UPDATE')) {
        entered.open();
        await finish.promise;
      }
      return {
        command: text.startsWith('UPDATE') ? 'UPDATE' : text,
        rows: [],
        fields: [],
        rowCount: text.startsWith('UPDATE') ? 1 : null,
        oid: 0,
      };
    },
    release,
  }) as unknown as PoolClient;
  t.mock.method(pool, 'connect', async () => client);
  const db = createTenon({ connection: pool });
  const failure = new Error('callback failed while query pending');
  let work: Promise<unknown> | undefined;
  const outcome = assert.rejects(
    db.transaction(async (tx) => {
      work = tx.query(sql`UPDATE items SET active = false`, { affectedRows: { exact: 1 } });
      await entered.promise;
      throw failure;
    }),
    (error) => error === failure,
  );
  try {
    await entered.promise;
    // Let the callback reject while its operation is still blocked.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statements.includes('ROLLBACK'), false);
    assert.equal(release.mock.callCount(), 0);
    finish.open();
    await outcome;
    await work;
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.ok(statements.at(-2)?.startsWith('RELEASE SAVEPOINT'));
    assert.equal(release.mock.callCount(), 1);
  } finally {
    finish.open();
    await outcome;
    await db.close();
    await pool.end();
  }
});
