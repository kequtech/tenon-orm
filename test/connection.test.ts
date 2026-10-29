import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, listen } from '@kequtech/pgclear';
import { createTenon, sql, type Connection, type ConnectionOptions } from '../src/index.js';
import { testConnection } from './helpers/database.js';

test('connections preserve native configuration without mutating caller options', async (t) => {
  const options: ConnectionOptions = Object.freeze({
    connectionString: testConnection,
    maxConnections: 2,
    connectTimeoutMs: 1500,
    applicationName: 'tenon_options',
    startupParameters: Object.freeze({ statement_timeout: '1500' }),
  });
  const db = createTenon({ connection: options });
  t.after(() => db.close());
  const row = await db.query(
    sql`SELECT current_setting('application_name') AS name,
    current_setting('TimeZone') AS zone`,
    { returns: 'one' },
  );
  assert.deepEqual(row, { name: 'tenon_options', zone: 'UTC' });
  const leases = await Promise.all([db.native.acquire(), db.native.acquire()]);
  try {
    assert.equal(db.native.stats.leased, 2);
    await assert.rejects(db.native.acquire({ timeoutMs: 0 }), { code: 'PGCLEAR_TIMEOUT' });
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
  }
  assert.equal(options.connectTimeoutMs, 1500);
});

test('removed URI wrappers reject before creating a pool', () => {
  for (const connection of [
    { url: '' },
    { url: ' ' },
    { url: 42 },
    { url: testConnection, maxConnections: 1 },
    { url: testConnection, options: null },
    { url: testConnection, options: [] },
  ])
    assert.throws(() => createTenon({ connection: connection as Connection }));
});

test(
  'native pools expose held sessions and dedicated listeners retain explicit ownership',
  { timeout: 10000 },
  async (t) => {
    const db = createTenon({ connection: testConnection });
    t.after(() => db.close({ timeoutMs: 0 }));
    const delivered = Promise.withResolvers<string>();
    const channel = 'tenon_connection_' + process.pid;
    const listener = await listen(testConnection, {
      channels: [channel],
      onNotification: (event) => delivered.resolve(event.payload),
    });
    try {
      const lease = await db.native.acquire();
      assert.deepEqual((await lease.queryClassic('SELECT $1::integer AS value', [42])).rows, [
        { value: 42 },
      ]);
      await lease.release();
      await assert.rejects(lease.queryClassic('SELECT 1', []), { code: 'PGCLEAR_EXPIRED' });
      await db.native.queryClassic('SELECT pg_notify($1,$2)', [channel, 'hello']);
      assert.equal(await delivered.promise, 'hello');
      await db.close();
      await assert.rejects(db.native.queryClassic('SELECT 1', []), { code: 'PGCLEAR_CLOSED' });
      assert.equal(listener.status.state, 'connected');
    } finally {
      await listener.close();
    }
  },
);

test('a standalone connection is rejected instead of being mistaken for a borrowed pool', async () => {
  const client = await connect(testConnection);
  try {
    assert.throws(() => createTenon({ connection: client as unknown as Connection }));
    assert.equal((await client.queryClassic('SELECT 1 AS value', [])).rows[0]!.value, 1);
  } finally {
    await client.close();
  }
});

test('owned pools remain cold until first use and close idempotently', async () => {
  const db = createTenon({ connection: testConnection });
  assert.deepEqual(db.native.stats, { total: 0, idle: 0, leased: 0, waiting: 0 });
  await db.close();
  await db.close();
});
