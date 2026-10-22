import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { createTenon, define } from '../src/index.js';
import type { Transaction } from '../src/index.js';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
const operations = { ping: define<never, []>('SELECT 1', { returns: 'native' }) };

test('sql and run reject direct transaction boundaries before dispatch on root and callback clients', async t => {
  const commands = [
    'BEGIN', 'begin work', 'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    'START /* nested /* comment */ done */ TRANSACTION',
    'COMMIT', 'COMMIT WORK AND CHAIN', 'COMMIT PREPARED \'name\'',
    'END TRANSACTION', 'ABORT WORK', 'ROLLBACK', 'ROLLBACK WORK AND CHAIN',
    'ROLLBACK PREPARED \'name\'', 'PREPARE /* comment */ TRANSACTION \'name\'',
    '; ; -- leading comment\r/* nested /* BEGIN */ comment */ cOmMiT;',
  ];
  const definitions = Object.fromEntries(commands.map((sql, i) => [`boundary_${i}`, define(sql)]));
  const pool = new Pool();
  const rootQuery = t.mock.method(pool, 'query', async () => { throw new Error('Public SQL reached the pool'); });
  const clientQuery = t.mock.fn(async (sql: string) => ({ command: sql, rows: [], fields: [], rowCount: null, oid: 0 }));
  const release = t.mock.fn();
  t.mock.method(pool, 'connect', async () => ({ query: clientQuery, release }) as unknown as PoolClient);
  const db = createTenon({ connection: pool, operations: definitions });
  async function check(client: Transaction<typeof definitions>) {
    for (const [i, sql] of commands.entries()) {
      await assert.rejects(client.sql(sql, []), { name: 'TenonError', message: /Inline SQL cannot start or end a transaction/ });
      await assert.rejects(client.run(`boundary_${i}`, []), { name: 'TenonError', message: new RegExp(`boundary_${i} cannot start or end a transaction`) });
    }
  }
  try {
    await check(db);
    await db.transaction(check);
    assert.equal(rootQuery.mock.callCount(), 0);
    assert.deepEqual(clientQuery.mock.calls.map(call => call.arguments[0]), ['BEGIN', 'COMMIT']);
    assert.equal(release.mock.callCount(), 1);
  } finally { await db.close(); await pool.end(); }
});

for (const boundary of ['COMMIT', 'ROLLBACK'] as const) {
  test(`callback scope expires while ${boundary} is pending, before returning its outcome`, async t => {
    const pool = new Pool();
    const entered = gate();
    const finish = gate();
    const failure = new Error('callback failed');
    const statements: string[] = [];
    const release = t.mock.fn();
    const client = {
      async query(command: string) {
        statements.push(command);
        if (command === boundary) { entered.open(); await finish.promise; }
        return { command, rows: [], fields: [], rowCount: null, oid: 0 };
      },
      release,
    } as unknown as PoolClient;
    t.mock.method(pool, 'connect', async () => client);
    const db = createTenon({ connection: pool, operations });
    let expired!: Transaction<typeof operations>;
    let settled = false;
    const pending = db.transaction(async tx => {
      expired = tx;
      if (boundary === 'ROLLBACK') throw failure;
      return { saved: true };
    });
    const outcome = pending.then(
      value => { settled = true; return { value }; },
      (error: unknown) => { settled = true; return { error }; },
    );
    try {
      await entered.promise;
      assert.equal(settled, false);
      assert.equal(release.mock.callCount(), 0);
      await assert.rejects(expired.sql<object>('SELECT 1', [], { returns: 'many' }), /transaction has finished/);
      await assert.rejects(expired.run('ping', []), /transaction has finished/);
      assert.deepEqual(statements, ['BEGIN', boundary]);
      finish.open();
      assert.deepEqual(await outcome, boundary === 'COMMIT' ? { value: { saved: true } } : { error: failure });
      assert.equal(release.mock.callCount(), 1);
    } finally {
      finish.open();
      await outcome;
      await db.close();
      await pool.end();
    }
  });
}
