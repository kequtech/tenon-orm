import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createPool } from '../src/connection.js';
import { createTenon, identifier, sql } from '../src/index.js';
import { withMigrationLock } from '../src/migrations/connection.js';
import { qualified } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const admin = new Pool({ connectionString: testConnection });
const project = migrationProject(admin);
before(() => assertTestDatabase(admin));
after(() => admin.end());

// Observe end rather than error: an extra error listener here would hide the
// unhandled-event failure these tests are intended to catch.
function nextDisconnect(pool: Pool): Promise<void> {
  return new Promise((resolve) => {
    pool.once('connect', (client) => client.once('end', resolve));
  });
}

async function disconnect(pid: number): Promise<void> {
  const result = await admin.query<{ stopped: boolean }>(
    'SELECT pg_terminate_backend($1) AS stopped',
    [pid],
  );
  assert.equal(result.rows[0]!.stopped, true);
}

function lostConnection(error: unknown): boolean {
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors[0].code, '57P01');
  assert.equal(error.errors.length, 2); // Original failure and unsuccessful rollback.
  return true;
}

test(
  'a backend lost between transaction queries rejects, rolls back writes and permits a fresh connection',
  { timeout: 10000 },
  async () => {
    await project({}, async ({ namespace }) => {
      const target = qualified(namespace, 'writes');
      await admin.query(`CREATE SCHEMA "${namespace}"; CREATE TABLE ${target} (id integer)`);
      const pool = new Pool({ connectionString: testConnection, max: 1 });
      const ended = nextDisconnect(pool);
      const db = createTenon({ connection: pool });
      let originalPid = 0;
      try {
        await assert.rejects(
          db.transaction(async (tx) => {
            const { rows } = await tx.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`);
            originalPid = rows[0]!.pid;
            await tx.query(sql`INSERT INTO ${identifier(namespace, 'writes')} VALUES (1)`);
            await disconnect(originalPid);
            await ended;
            return 'must not succeed';
          }),
          lostConnection,
        );
        assert.deepEqual((await admin.query(`SELECT * FROM ${target}`)).rows, []);
        const replacement = await db.transaction((tx) =>
          tx.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`, { returns: 'one' }),
        );
        assert.notEqual(replacement.pid, originalPid);
      } finally {
        await db.close();
        await pool.end();
      }
    });
  },
);

test(
  'tools preserve a backend failure between queries and release the broken client',
  { timeout: 10000 },
  async () => {
    await project({}, async ({ namespace }) => {
      const pool = new Pool({ connectionString: testConnection, max: 1 });
      const ended = nextDisconnect(pool);
      try {
        await assert.rejects(
          withMigrationLock({ connection: pool, namespace }, 'exclusive', async (client) => {
            const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
            await disconnect(rows[0]!.pid);
            await ended;
          }),
          lostConnection,
        );
        // The session lock must also disappear with the terminated backend.
        assert.equal(
          await withMigrationLock({ connection: pool, namespace }, 'exclusive', async () => 42),
          42,
        );
      } finally {
        await pool.end();
      }
    });
  },
);

test(
  'owned pools report idle disconnections as warnings and replace the lost connection',
  { timeout: 10000 },
  async (t) => {
    const warning = t.mock.method(process, 'emitWarning', () => {});
    const { pool } = createPool(testConnection);
    const ended = nextDisconnect(pool);
    try {
      const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await disconnect(rows[0]!.pid);
      await ended;
      assert.equal(warning.mock.callCount(), 1);
      const error = warning.mock.calls[0]!.arguments[0];
      assert.ok(error instanceof Error && 'code' in error);
      assert.equal(error.code, '57P01');
      const next = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      assert.notEqual(next.rows[0]!.pid, rows[0]!.pid);
    } finally {
      await pool.end();
    }
  },
);
