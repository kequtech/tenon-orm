import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import { createTenon, sql, type Connection, type ConnectionOptions } from '../src/index.js';
import { testConnection } from './helpers/database.js';

test('connections pass pg configuration without mutating caller options', async (t) => {
  const options: ConnectionOptions = {
    max: 2,
    connectionTimeoutMillis: 1500,
    application_name: 'tenon_options',
    options: '-c timezone=UTC',
  };
  const connection: ConnectionOptions = {
    connectionString: testConnection.replace(/([?&])options=[^&]*/, '$1'),
    ...options,
  };
  const db = createTenon({ connection });
  t.after(() => db.close());
  assert.equal(db.native.options.max, 2);
  assert.equal(db.native.options.connectionTimeoutMillis, 1500);
  const row = await db.query(
    sql`SELECT current_setting('application_name') AS name, current_setting('TimeZone') AS zone`,
    { returns: 'one' },
  );
  assert.deepEqual(row, { name: 'tenon_options', zone: 'UTC' });
  assert.deepEqual(options, {
    max: 2,
    connectionTimeoutMillis: 1500,
    application_name: 'tenon_options',
    options: '-c timezone=UTC',
  });
});

test('removed URI wrappers reject before creating a pool', () => {
  for (const connection of [
    { url: '' },
    { url: ' ' },
    { url: 42 },
    { url: testConnection, max: 1 },
    { url: testConnection.replace(/([?&])options=[^&]*/, '$1'), options: null },
    { url: testConnection.replace(/([?&])options=[^&]*/, '$1'), options: [] },
  ])
    assert.throws(() => createTenon({ connection: connection as Connection }));
});

test(
  'native pools expose standard pg connect, notification and end events',
  { timeout: 10000 },
  async (t) => {
    const db = createTenon({
      connection: { connectionString: testConnection, max: 2 },
    });
    t.after(() => db.close({ timeoutMs: 0 }));
    const client = await db.native.connect();
    client.on('error', () => {});
    const notification = new Promise<{ channel: string; payload?: string }>((resolve) =>
      client.once('notification', resolve),
    );
    await client.query('LISTEN tenon_connection');
    await db.native.query("SELECT pg_notify('tenon_connection','hello')");
    const event = await notification;
    assert.equal(event.channel, 'tenon_connection');
    assert.equal(event.payload, 'hello');
    client.release();
    await db.close();
    await assert.rejects(db.native.query('SELECT 1'), /after calling end/);
  },
);

test('a standalone pg Client is rejected instead of being mistaken for a borrowed pool', () => {
  const client = new Client({ connectionString: testConnection });
  assert.throws(
    () => createTenon({ connection: client as unknown as Connection }),
    /Connection configuration/,
  );
});

test('owned pools keep pg defaults unless connection options override them', async (t) => {
  const db = createTenon({ connection: testConnection });
  t.after(() => db.close());
  assert.equal(db.native.options.connectionTimeoutMillis, undefined);
});
