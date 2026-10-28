import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import postgres from 'postgres';
import {
  createTenon,
  sql,
  type Connection,
  type ConnectionOptions,
  type ConnectionUri,
} from '../src/index.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const admin = postgres(testConnection);
before(() => assertTestDatabase(admin));
after(() => admin.end());

test('URI connections preserve driver parsing of credentials, TLS and option precedence', async () => {
  const options: ConnectionOptions = {
    max: 2,
    connect_timeout: 5,
    ssl: 'require',
    connection: { application_name: 'from-options', TimeZone: 'UTC' },
  };
  const connection: ConnectionUri = {
    url: 'postgresql://test%40user:test%3Ap%40ss@localhost/unused?sslmode=verify-full&connect_timeout=3&application_name=from-uri',
    options,
  };
  const db = createTenon({ connection });
  try {
    assert.equal(db.native.options.user, 'test@user');
    assert.equal(db.native.options.pass, 'test:p@ss');
    assert.equal(db.native.options.ssl, 'require');
    assert.equal(db.native.options.max, 2);
    assert.equal(db.native.options.connect_timeout, 5);
    assert.equal(db.native.options.connection.application_name, 'from-uri');
    assert.equal(db.native.options.connection.TimeZone, 'UTC');
    assert.equal(options.connection?.application_name, 'from-options');
  } finally {
    await db.close();
  }
  const uriOnly = createTenon({ connection: { url: connection.url } });
  try {
    assert.equal(uriOnly.native.options.ssl, 'verify-full');
    assert.equal(uriOnly.native.options.connect_timeout, 3);
  } finally {
    await uriOnly.close();
  }
});

test('URI connections reject invalid wrappers before creating a client', () => {
  for (const connection of [
    { url: '' },
    { url: '  ' },
    { url: 42 },
    { url: testConnection, max: 1 },
    { url: testConnection, options: null },
    { url: testConnection, options: [] },
  ]) {
    assert.throws(() => createTenon({ connection: connection as Connection }));
  }
});

test(
  'URI options install native callbacks at construction and retain owned shutdown',
  { timeout: 10000 },
  async (t) => {
    const channel = `tenon_connection_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(testConnection);
    url.searchParams.set('application_name', channel);
    url.searchParams.set('TimeZone', 'UTC');
    let notify!: (value: [string, string]) => void;
    const notification = new Promise<[string, string]>((resolve) => {
      notify = resolve;
    });
    let close!: (id: number) => void;
    const closed = new Promise<number>((resolve) => {
      close = resolve;
    });
    const db = createTenon({
      connection: {
        url: url.toString(),
        options: { max: 1, onnotify: (name, payload) => notify([name, payload]), onclose: close },
      },
    });
    t.after(() => db.close());
    // Exercise Tenon's onclose observation as well as native notifications.
    await db.transaction(async (tx) => {
      const row = await tx.query(
        sql<{
          zone: string;
          name: string;
        }>`SELECT current_setting('TimeZone') AS zone, current_setting('application_name') AS name`,
        { returns: 'one' },
      );
      assert.deepEqual(row, { zone: 'UTC', name: channel });
    });
    await db.native.unsafe(`LISTEN "${channel}"`);
    await admin`SELECT pg_notify(${channel}, 'hello')`;
    assert.deepEqual(await notification, [channel, 'hello']);
    const [backend] = await db.native<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await admin`SELECT pg_terminate_backend(${backend!.pid})`;
    assert.equal(typeof (await closed), 'number');
    assert.equal(
      (await db.query(sql<{ value: number }>`SELECT 42 AS value`, { returns: 'one' })).value,
      42,
    );
    await db.close();
    await assert.rejects(db.native`SELECT 1`, { code: 'CONNECTION_ENDED' });
  },
);
