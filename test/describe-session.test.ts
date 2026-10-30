import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { after, before, test } from 'node:test';
import { createPool, type Pool } from '@kequtech/pgclear';
import { describeQuery, migrate, sql } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const pool = createPool({ connectionString: testConnection });
const project = migrationProject(pool);
before(() => assertTestDatabase(pool));
after(() => pool.close());

function markedConnection() {
  const url = new URL(testConnection);
  const name = `tenon_describe_${randomUUID().replaceAll('-', '')}`;
  url.searchParams.set('application_name', name);
  return { connection: url.toString(), name };
}

async function assertDisconnected(name: string): Promise<void> {
  // A completed TCP close can precede the backend's removal from pg_stat_activity.
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = (
      await pool.queryClassic('SELECT 1 FROM pg_stat_activity WHERE application_name=$1', [name])
    ).rows;
    if (!result.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Inspection backend was not released.');
}

test('inspection matches explicit role, search path and timezone and reports the effective context', async () => {
  const role = `tenon_inspect_${randomUUID().replaceAll('-', '')}`;
  await pool.queryClassic(`CREATE ROLE ${quote(role)} NOLOGIN`, []);
  try {
    await project(
      {
        '0001_fixture.up.sql':
          'CREATE TABLE scoped (id integer NOT NULL); INSERT INTO scoped VALUES (7);',
      },
      async (options) => {
        await migrate(options);
        await pool.withSession((session) =>
          session.script(`GRANT USAGE ON SCHEMA ${quote(options.namespace)} TO ${quote(role)};
        GRANT SELECT ON ${qualified(options.namespace, 'scoped')} TO ${quote(role)}`),
        );
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
          readMappings: 'pgclear',
          database: 'tenon_orm_test',
          sessionUser: (await pool.queryClassic('SELECT session_user AS name', [])).rows[0]!.name,
          currentUser: role,
          searchPath: session.searchPath,
          resolvedSearchPath: ['pg_catalog', options.namespace, 'public'],
          timeZone: 'UTC',
          statementTimeoutMs: 5000,
          lockTimeoutMs: 1000,
        });
        const client = await pool.acquire();
        try {
          await client.queryClassic('BEGIN', []);
          await client.queryClassic(
            "SELECT set_config('role',$1,true) AS role,set_config('search_path',$2,true) AS path,set_config('TimeZone',$3,true) AS zone",
            [session.role, session.searchPath, session.timeZone],
          );
          assert.deepEqual(
            [
              ...(
                await client.queryClassic(
                  "SELECT id,current_user AS role,current_setting('TimeZone') AS zone FROM scoped",
                  [],
                )
              ).rows,
            ],
            [{ id: 7, role, zone: 'UTC' }],
          );
          await assert.rejects(client.queryClassic('UPDATE scoped SET id=8', []), {
            code: '42501',
          });
        } finally {
          await client.queryClassic('ROLLBACK', []);
          client.release();
        }
        await assert.rejects(
          describeQuery({ connection: testConnection, query: 'SELECT id FROM scoped' }),
          { code: '42P01' },
        );
        await pool.queryClassic(
          `REVOKE USAGE ON SCHEMA ${quote(options.namespace)} FROM ${quote(role)}`,
          [],
        );
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
    await pool.queryClassic(`DROP ROLE ${quote(role)}`, []);
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
  const result = await describeQuery({
    connection: url.toString(),
    query: 'SELECT relname FROM pg_class',
    session: { searchPath: 'pg_catalog', timeZone: 'UTC' },
    timeouts: { connectMs: 1000, statementMs: 400, lockMs: 200 },
  });
  assert.equal(result.context.searchPath, 'pg_catalog');
  assert.equal(result.context.timeZone, 'UTC');
  assert.equal(result.context.statementTimeoutMs, 400);
  assert.equal(result.context.lockTimeoutMs, 200);
});

test('inspection enforces its timeout bounds across startup parameter casing', async () => {
  const startupParameters = {
    statement_timeout: '0',
    Statement_Timeout: '0',
    lock_timeout: '0',
    LOCK_TIMEOUT: '0',
  };
  const result = await describeQuery({
    connection: { connectionString: testConnection, startupParameters },
    query: 'SELECT 1 AS value',
    timeouts: { statementMs: 400, lockMs: 200 },
  });
  assert.equal(result.context.statementTimeoutMs, 400);
  assert.equal(result.context.lockTimeoutMs, 200);
  assert.equal(startupParameters.Statement_Timeout, '0');
  for (const startupParameters of [null, []]) {
    await assert.rejects(
      describeQuery({
        connection: {
          connectionString: testConnection,
          // @ts-expect-error simulate untyped configuration
          startupParameters,
        },
        query: 'SELECT 1',
      }),
      /Startup parameters must be a plain object/,
    );
  }
});

test('Describe lock and statement timeouts terminate blocked parsing and release the backend', async () => {
  await project(
    { '0001_fixture.up.sql': 'CREATE TABLE blocked (id integer);' },
    async (options) => {
      await migrate(options);
      const blocker = await pool.acquire();
      try {
        await blocker.queryClassic('BEGIN', []);
        await blocker.queryClassic(
          `LOCK TABLE ${qualified(options.namespace, 'blocked')} IN ACCESS EXCLUSIVE MODE`,
          [],
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
        await blocker.queryClassic('ROLLBACK', []);
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
      { code: 'PGCLEAR_TIMEOUT' },
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
      const client = await pool.acquire();
      try {
        await client.queryClassic('BEGIN', []);
        await client.queryClassic("SELECT set_config('search_path',$1,true)", [
          quote(options.namespace),
        ]);
        await client.queryClassic(
          'CREATE TEMPORARY TABLE local_probe(id integer) ON COMMIT DROP',
          [],
        );
        assert.deepEqual([...(await client.queryClassic('SELECT * FROM local_only', [])).rows], []);
        assert.deepEqual(
          [...(await client.queryClassic('SELECT * FROM local_probe', [])).rows],
          [],
        );
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
        assert.equal(configured.context.readMappings, 'pgclear');
      } finally {
        await client.queryClassic('ROLLBACK', []);
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

test('undefined optional inspection settings use defaults without bypassing validation', async () => {
  const description = await describeQuery({
    connection: testConnection,
    query: 'SELECT 1 AS id',
    session: { role: undefined, searchPath: undefined, timeZone: undefined },
    timeouts: { connectMs: undefined, statementMs: undefined, lockMs: undefined },
  });
  assert.equal(description.context.statementTimeoutMs, 5000);
  assert.equal(description.context.lockTimeoutMs, 1000);
  assert.equal(description.columns[0]!.readType, 'number');
  for (const [settings, error] of [
    [{ session: { unknown: undefined } }, /Unknown inspection session option/],
    [{ timeouts: { unknown: undefined } }, /Unknown inspection timeout/],
    [{ session: { role: null } }, /requires a nonempty string/],
    [{ timeouts: { statementMs: null } }, /must be a positive integer/],
    [{ timeouts: { statementMs: 0 } }, /must be a positive integer/],
  ] as const) {
    await assert.rejects(
      describeQuery({
        connection: 'postgresql://unused',
        query: 'SELECT 1',
        ...(settings as Pick<import('../src/index.js').DescribeOptions, 'session' | 'timeouts'>),
      }),
      error,
    );
  }
});

test('inspection internal queries are independent of functions in the inspected search path', async () => {
  await project(
    {
      '0001_shadow.up.sql': `
      CREATE TYPE state AS ENUM ('ready', 'waiting');
      CREATE TABLE scoped (id integer NOT NULL, state state NOT NULL);
      CREATE FUNCTION set_config(text, text, boolean) RETURNS text LANGUAGE plpgsql AS
        $$BEGIN RAISE EXCEPTION 'application set_config was called'; END$$;
      CREATE FUNCTION current_database() RETURNS name LANGUAGE sql AS $$SELECT 'wrong_database'::name$$;
      CREATE FUNCTION to_json(anyelement) RETURNS json LANGUAGE sql AS $$SELECT '[]'::json$$;
    `,
    },
    async (options) => {
      await migrate(options);
      const result = await describeQuery({
        connection: testConnection,
        query: 'SELECT id, state FROM scoped',
        session: { searchPath: `${quote(options.namespace)}, pg_catalog`, timeZone: 'UTC' },
      });
      assert.equal(result.context.database, 'tenon_orm_test');
      assert.equal(result.context.timeZone, 'UTC');
      assert.deepEqual(result.context.resolvedSearchPath, [options.namespace, 'pg_catalog']);
      assert.equal(result.columns[0]!.source?.schema, options.namespace);
      assert.equal(result.columns[0]!.readType, 'number');
      assert.equal(result.columns[1]!.readType, 'string');
    },
  );
});

test(
  'inspection releases resources after success and parse errors',
  { timeout: 10000 },
  async () => {
    const url = new URL(testConnection);

    const module = new URL('../src/index.js', import.meta.url).href;
    for (const [query, expectedCode] of [
      ['SELECT 1 AS value', undefined],
      ['SELECT missing_column', '42703'],
    ]) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import assert from 'node:assert/strict';
      import { describeQuery } from ${JSON.stringify(module)};
      const inspection = describeQuery({connection: process.env.TENON_TEST_DATABASE_URL, query: ${JSON.stringify(query)}});
      ${expectedCode ? `await assert.rejects(inspection, {code:${JSON.stringify(expectedCode)}});` : 'await inspection;'}
      console.log('finished');
    `,
        ],
        { env: { ...process.env, TENON_TEST_DATABASE_URL: url.toString() }, timeout: 3000 },
      );
      assert.equal(stdout.trim(), 'finished');
    }
  },
);

test(
  'inspection honors lock timeouts while Describe is waiting on a lock',
  { timeout: 10000 },
  async () => {
    await project(
      { '0001_blocked.up.sql': 'CREATE TABLE blocked (id integer);' },
      async (options) => {
        await migrate(options);
        const blocker = await pool.acquire();
        const { connection, name } = markedConnection();
        const url = new URL(connection);

        try {
          await blocker.queryClassic('BEGIN', []);
          await blocker.queryClassic(
            `LOCK TABLE ${qualified(options.namespace, 'blocked')} IN ACCESS EXCLUSIVE MODE`,
            [],
          );
          const started = performance.now();
          await assert.rejects(
            describeQuery({
              connection: url.toString(),
              query: `SELECT * FROM ${qualified(options.namespace, 'blocked')}`,
              timeouts: { statementMs: 5000, lockMs: 50 },
            }),
            { code: '55P03' },
          );
          assert.ok(performance.now() - started < 2000);
        } finally {
          await blocker.queryClassic('ROLLBACK', []);
          blocker.release();
        }
        await assertDisconnected(name);
      },
    );
  },
);
