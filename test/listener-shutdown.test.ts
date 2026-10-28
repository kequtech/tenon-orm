import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { createTenon, sql } from '../src/index.js';
import { testConnection, migrationProject, assertTestDatabase } from './helpers/database.js';
import { Pool } from 'pg';
import { identifier, migrate } from '../src/index.js';
import { postgresProxy } from './helpers/proxy.js';

test(
  'owned close ends a checked-out native LISTEN client at its deadline',
  { timeout: 10000 },
  async (t) => {
    const db = createTenon({ connection: testConnection });
    t.after(() => db.close({ timeoutMs: 0 }));
    const client = await db.native.connect();
    client.on('error', () => {});
    await client.query('LISTEN tenon_shutdown');
    const ended = once(client, 'end');
    const started = performance.now();
    await db.close({ timeoutMs: 30 });
    await ended;
    assert.ok(performance.now() - started < 2000);
    await assert.rejects(client.query('SELECT 1'), /closed|not queryable/);
    client.release();
    await assert.rejects(db.native.connect(), /after calling end/);
  },
);

test(
  'a lost native listener closes without reconnecting and requires application recovery',
  { timeout: 10000 },
  async (t) => {
    const proxy = await postgresProxy(testConnection);
    const db = createTenon({ connection: proxy.connection });
    t.after(async () => {
      await db.close({ timeoutMs: 0 });
      await proxy.close();
    });
    const client = await db.native.connect();
    client.on('error', () => {});
    await client.query('LISTEN tenon_disconnect');
    const ended = new Promise<void>((resolve) => client.once('end', resolve));
    proxy.setAvailable(false);
    await ended;
    const attempts = proxy.attempts;
    proxy.setAvailable(true);
    await pause(100);
    assert.equal(proxy.attempts, attempts);
    await assert.rejects(client.query('SELECT 1'), /closed|not queryable/);
    client.release(true);
    const replacement = await db.native.connect();
    await replacement.query('LISTEN tenon_disconnect');
    replacement.release();
  },
);

test(
  'owned close bounds work waiting for initial authentication',
  { timeout: 10000 },
  async (t) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.resume();
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const db = createTenon({
      connection: {
        connectionString: `postgresql://probe@127.0.0.1:${address.port}/probe`,
        connectionTimeoutMillis: 80,
      },
    });
    t.after(() => db.close({ timeoutMs: 0 }));
    const query = db.query(sql`SELECT 1`).catch((error: unknown) => error);
    for (let i = 0; sockets.size === 0; i++) {
      assert.ok(i < 100);
      await pause(5);
    }
    await db.close({ timeoutMs: 0 });
    assert.match(String(await query), /shutdown deadline/);
    for (let i = 0; sockets.size; i++) {
      assert.ok(i < 100);
      await pause(5);
    }
  },
);

async function eventually(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await pause(10);
  }
  assert.fail(message);
}

for (const [outcome, first] of [
  ['stalled', 'query'],
  ['connected', 'query'],
  ['connected', 'transaction'],
  ['disconnected', 'transaction'],
] as const) {
  test(
    `owned close with pg defaults rejects ${first} work when authentication is ${outcome}`,
    { timeout: 10000 },
    async (t) => {
      const admin = new Pool({ connectionString: testConnection });
      t.after(() => admin.end());
      await assertTestDatabase(admin);
      await migrationProject(admin)(
        { '0001_records.up.sql': 'CREATE TABLE records (id integer);' },
        async (options) => {
          await migrate(options);
          const proxy = await postgresProxy(testConnection);
          proxy.setPaused(true);
          const db = createTenon({ connection: { connectionString: proxy.connection, max: 1 } });
          t.after(async () => {
            await db.close({ timeoutMs: 0 });
            await proxy.close();
          });
          let callbackRan = false;
          const target = identifier(options.namespace, 'records');
          const insert = () => db.query(sql`INSERT INTO ${target} VALUES (1)`);
          const transaction = () =>
            db.transaction(async (tx) => {
              callbackRan = true;
              await tx.query(sql`INSERT INTO ${target} VALUES (2)`);
            });
          const operations =
            first === 'query' ? [insert(), transaction()] : [transaction(), insert()];
          const results = Promise.allSettled(operations);
          await eventually(
            () => proxy.sockets === 2,
            'The pending connection did not reach the proxy.',
          );
          const started = performance.now();
          const closing = db.close({ timeoutMs: 20 });
          assert.equal(db.close({ timeoutMs: 0 }), closing);
          await closing;
          assert.ok(performance.now() - started < 2000);
          for (const result of await results) {
            assert.equal(result.status, 'rejected');
            if (result.status === 'rejected')
              assert.match(String(result.reason), /shutdown deadline/);
          }
          if (outcome === 'stalled') {
            await pause(100);
            assert.equal(
              proxy.sockets,
              2,
              'pg acquisition remains pending without an application timeout.',
            );
            assert.equal(callbackRan, false);
            proxy.setAvailable(false);
          } else if (outcome === 'connected') {
            proxy.setPaused(false);
          } else {
            proxy.setAvailable(false);
          }
          await eventually(() => proxy.sockets === 0, 'The late connection was not closed.');
          assert.equal(
            callbackRan,
            false,
            'Expired transactions must never invoke application work.',
          );
          assert.deepEqual(
            (await admin.query(`SELECT * FROM "${options.namespace}".records`)).rows,
            [],
          );
          await assert.rejects(db.query(sql`SELECT 1`), /closed/);
          await assert.rejects(db.native.connect(), /after calling end/);
        },
      );
    },
  );
}
