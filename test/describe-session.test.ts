import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { after, before, test } from 'node:test';
import postgres from 'postgres';
import { describeQuery, migrate, sql } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const pool = postgres(testConnection);
const project = migrationProject(pool);
before(() => assertTestDatabase(pool));
after(() => pool.end());

function markedConnection() {
  const url = new URL(testConnection);
  const name = `tenon_describe_${randomUUID().replaceAll('-', '')}`;
  url.searchParams.set('application_name', name);
  return { connection: url.toString(), name };
}

async function assertDisconnected(name: string): Promise<void> {
  // A completed TCP close can precede the backend's removal from pg_stat_activity.
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await pool.unsafe('SELECT 1 FROM pg_stat_activity WHERE application_name=$1', [
      name,
    ]);
    if (!result.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Inspection backend was not released.');
}

test('inspection matches explicit role, search path and timezone and reports the effective context', async () => {
  const role = `tenon_inspect_${randomUUID().replaceAll('-', '')}`;
  await pool.unsafe(`CREATE ROLE ${quote(role)} NOLOGIN`);
  try {
    await project(
      {
        '0001_fixture.up.sql':
          'CREATE TABLE scoped (id integer NOT NULL); INSERT INTO scoped VALUES (7);',
      },
      async (options) => {
        await migrate(options);
        await pool.unsafe(`GRANT USAGE ON SCHEMA ${quote(options.namespace)} TO ${quote(role)};
        GRANT SELECT ON ${qualified(options.namespace, 'scoped')} TO ${quote(role)}`);
        const session = {
          role,
          searchPath: `${quote(options.namespace)}, public`,
          timeZone: 'UTC',
        };
        const description = await describeQuery({
          connection: testConnection,
          session,
          query: 'SELECT id FROM scoped',
        });
        assert.equal(description.columns[0]!.readType, 'number');
        assert.equal(description.columns[0]!.source?.schema, options.namespace);
        const write = await describeQuery({
          connection: testConnection,
          session,
          query: 'UPDATE scoped SET id=8 RETURNING id',
        });
        assert.equal(write.columns[0]!.readType, 'number');
        assert.deepEqual(description.context, {
          mode: 'separate-session',
          readMappings: 'postgres',
          database: 'tenon_orm_test',
          sessionUser: (await pool.unsafe('SELECT session_user AS name'))[0]!.name,
          currentUser: role,
          searchPath: session.searchPath,
          resolvedSearchPath: ['pg_catalog', options.namespace, 'public'],
          timeZone: 'UTC',
          statementTimeoutMs: 5000,
          lockTimeoutMs: 1000,
        });
        const client = await pool.reserve();
        try {
          await client.unsafe('BEGIN');
          await client.unsafe(
            "SELECT set_config('role',$1,true),set_config('search_path',$2,true),set_config('TimeZone',$3,true)",
            [session.role, session.searchPath, session.timeZone],
          );
          assert.deepEqual(
            [
              ...(await client.unsafe(
                "SELECT id,current_user AS role,current_setting('TimeZone') AS zone FROM scoped",
              )),
            ],
            [{ id: 7, role, zone: 'UTC' }],
          );
          await assert.rejects(client.unsafe('UPDATE scoped SET id=8'), { code: '42501' });
        } finally {
          await client.unsafe('ROLLBACK');
          client.release();
        }
        await assert.rejects(
          describeQuery({ connection: testConnection, query: 'SELECT id FROM scoped' }),
          { code: '42P01' },
        );
        await pool.unsafe(`REVOKE USAGE ON SCHEMA ${quote(options.namespace)} FROM ${quote(role)}`);
        await assert.rejects(
          describeQuery({
            connection: testConnection,
            session,
            query: `SELECT id FROM ${qualified(options.namespace, 'scoped')}`,
          }),
          { code: '42501' },
        );
      },
    );
  } finally {
    await pool.unsafe(`DROP ROLE ${quote(role)}`);
  }
});

test('inspection captures session settings and limits before asynchronous work starts', async () => {
  const session = { searchPath: 'pg_catalog', timeZone: 'UTC' };
  const timeouts = { statementMs: 5000, lockMs: 1000 };
  const pending = describeQuery({
    connection: testConnection,
    query: 'SELECT oid FROM pg_class LIMIT 1',
    session,
    timeouts,
  });
  session.searchPath = 'absent_schema';
  session.timeZone = 'invalid_zone';
  timeouts.statementMs = 0;
  timeouts.lockMs = 0;
  const description = await pending;
  assert.equal(description.context.searchPath, 'pg_catalog');
  assert.equal(description.context.timeZone, 'UTC');
  assert.equal(description.context.statementTimeoutMs, 5000);
  assert.equal(description.context.lockTimeoutMs, 1000);
  assert.equal(description.columns[0]!.readType, 'number');
});

test('connection URL session options are preserved while timeout overrides cannot disable bounds', async () => {
  const url = new URL(testConnection);
  url.searchParams.set(
    'options',
    '-c search_path=pg_catalog -c timezone=UTC -c statement_timeout=0 -c lock_timeout=0',
  );
  url.searchParams.set('statement_timeout', '0');
  url.searchParams.set('lock_timeout', '0');
  const result = await describeQuery({
    connection: url.toString(),
    query: 'SELECT relname FROM pg_class',
    timeouts: { connectMs: 1000, statementMs: 400, lockMs: 200 },
  });
  assert.equal(result.context.searchPath, 'pg_catalog');
  assert.equal(result.context.timeZone, 'UTC');
  assert.equal(result.context.statementTimeoutMs, 400);
  assert.equal(result.context.lockTimeoutMs, 200);
});

test('Describe lock and statement timeouts terminate blocked parsing and release the backend', async () => {
  await project(
    { '0001_fixture.up.sql': 'CREATE TABLE blocked (id integer);' },
    async (options) => {
      await migrate(options);
      const blocker = await pool.reserve();
      try {
        await blocker.unsafe('BEGIN');
        await blocker.unsafe(
          `LOCK TABLE ${qualified(options.namespace, 'blocked')} IN ACCESS EXCLUSIVE MODE`,
        );
        for (const [statementMs, lockMs, code] of [
          [1000, 60, '55P03'],
          [60, 1000, '57014'],
        ] as const) {
          const { connection, name } = markedConnection();
          const started = performance.now();
          await assert.rejects(
            describeQuery({
              connection,
              query: `SELECT id FROM ${qualified(options.namespace, 'blocked')}`,
              timeouts: { connectMs: 1000, statementMs, lockMs },
            }),
            { code },
          );
          assert.ok(performance.now() - started < 3000, 'Blocked Describe must be bounded.');
          await assertDisconnected(name);
        }
      } finally {
        await blocker.unsafe('ROLLBACK');
        blocker.release();
      }
      assert.equal(
        (
          await describeQuery({
            connection: testConnection,
            query: `SELECT id FROM ${qualified(options.namespace, 'blocked')}`,
          })
        ).columns[0]!.readType,
        'number',
      );
    },
  );
});

test('a stalled authentication connection times out and closes its socket', async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.resume();
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const started = performance.now();
    await assert.rejects(
      describeQuery({
        connection: `postgresql://probe@127.0.0.1:${address.port}/probe`,
        query: 'SELECT 1',
        timeouts: { connectMs: 80 },
      }),
      { code: 'CONNECT_TIMEOUT' },
    );
    assert.ok(performance.now() - started < 2500);
    for (let attempt = 0; sockets.size && attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(sockets.size, 0, 'Connect timeout must close the stalled socket.');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('inspection explicitly remains outside temporary tables and transaction-local settings', async () => {
  await project(
    { '0001_fixture.up.sql': 'CREATE TABLE local_only (id integer);' },
    async (options) => {
      await migrate(options);
      const client = await pool.reserve();
      try {
        await client.unsafe('BEGIN');
        await client.unsafe("SELECT set_config('search_path',$1,true)", [quote(options.namespace)]);
        await client.unsafe('CREATE TEMPORARY TABLE local_probe(id integer) ON COMMIT DROP');
        assert.deepEqual([...(await client.unsafe('SELECT * FROM local_only'))], []);
        assert.deepEqual([...(await client.unsafe('SELECT * FROM local_probe'))], []);
        for (const table of ['local_only', 'local_probe']) {
          await assert.rejects(
            describeQuery({ connection: testConnection, query: `SELECT * FROM ${table}` }),
            { code: '42P01' },
          );
        }
        const configured = await describeQuery({
          connection: testConnection,
          session: { searchPath: quote(options.namespace) },
          query: 'SELECT * FROM local_only',
        });
        assert.equal(configured.context.mode, 'separate-session');
        assert.equal(configured.context.readMappings, 'postgres');
      } finally {
        await client.unsafe('ROLLBACK');
        client.release();
      }
    },
  );
});

test('invalid session and timeout settings reject explicitly and database errors release resources', async () => {
  for (const connectMs of [0, -1, NaN, Infinity, 0.5, 2147483648]) {
    await assert.rejects(
      describeQuery({
        connection: 'postgresql://unused',
        query: 'SELECT 1',
        timeouts: { connectMs },
      }),
      /positive integer/,
    );
  }
  for (const role of ['', ' ', 'bad\0role']) {
    await assert.rejects(
      describeQuery({ connection: 'postgresql://unused', query: 'SELECT 1', session: { role } }),
      /session role/,
    );
  }
  const { connection, name } = markedConnection();
  await assert.rejects(
    describeQuery({ connection, query: 'SELECT 1', session: { role: `absent_${randomUUID()}` } }),
    { code: '22023' },
  );
  await assertDisconnected(name);
  assert.equal(
    (await describeQuery({ connection, query: sql`SELECT 1 AS id` })).columns[0]!.readType,
    'number',
  );
  await assertDisconnected(name);
});
