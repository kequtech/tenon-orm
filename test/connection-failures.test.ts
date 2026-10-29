import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool, type Pool } from '@kequtech/pgclear';
import { createTenon, identifier, sql } from '../src/index.js';
import { withMigrationLock } from '../src/migrations/connection.js';
import { qualified } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const admin = createPool({ connectionString: testConnection });
const project = migrationProject(admin);
before(() => assertTestDatabase(admin));
after(() => admin.close());
function observedConnection() {
  let closed!: () => void;
  const ended = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const pool = createPool({
    connectionString: testConnection,
    maxConnections: 1,
    onEvent: (event) => {
      if (event.type === 'disconnect') closed();
    },
  });
  return { pool, ended };
}
async function disconnect(pid: number) {
  const [row] = (await admin.queryClassic('SELECT pg_terminate_backend($1) AS stopped', [pid]))
    .rows;
  assert.equal(row!.stopped, true);
}
function lostConnection(error: unknown): boolean {
  const errors = error instanceof AggregateError ? error.errors : [error];
  assert.ok(
    errors.some(
      (item) => item && ['PGCLEAR_CLOSED', 'PGCLEAR_CONNECTION_LOST', '57P01'].includes(item.code),
    ),
  );
  return true;
}

test(
  'a backend lost between transaction queries rejects, rolls back writes and permits a fresh connection',
  { timeout: 10000 },
  async () => {
    await project({}, async ({ namespace }) => {
      const target = qualified(namespace, 'writes');
      await admin.withSession((session) =>
        session.script(`CREATE SCHEMA "${namespace}"; CREATE TABLE ${target} (id integer)`),
      );
      const { pool, ended } = observedConnection();
      const db = createTenon({ connection: pool });
      let originalPid = 0;
      try {
        await assert.rejects(
          db.transaction(async (tx) => {
            const [row] = (await tx.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`))
              .rows;
            originalPid = row!.pid;
            await tx.query(sql`INSERT INTO ${identifier(namespace, 'writes')} VALUES (1)`);
            await disconnect(originalPid);
            await ended;
            await assert.rejects(
              tx.query(sql`INSERT INTO ${identifier(namespace, 'writes')} VALUES (2)`),
              /closed|connection|terminat/i,
            );
            return 'must not succeed';
          }),
          lostConnection,
        );
        assert.equal((await admin.queryClassic(`SELECT * FROM ${target}`, [])).rows.length, 0);
        const replacement = await db.transaction((tx) =>
          tx.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`, { returns: 'one' }),
        );
        assert.notEqual(replacement.pid, originalPid);
      } finally {
        await db.close();
        await pool.close();
      }
    });
  },
);

test(
  'tools preserve a backend failure between queries and release its advisory lock',
  { timeout: 10000 },
  async () => {
    await project({}, async ({ namespace }) => {
      const { pool, ended } = observedConnection();
      try {
        await assert.rejects(
          withMigrationLock({ connection: pool, namespace }, 'exclusive', async (client) => {
            const [row] = (
              await client.queryClassic<{ pid: number }>('SELECT pg_backend_pid() AS pid', [])
            ).rows;
            await disconnect(row!.pid);
            await ended;
          }),
          lostConnection,
        );
        assert.equal(
          await withMigrationLock({ connection: pool, namespace }, 'exclusive', async () => 42),
          42,
        );
      } finally {
        await pool.close();
      }
    });
  },
);

test(
  'idle disconnections retain native driver recovery without unhandled errors',
  { timeout: 10000 },
  async () => {
    const { pool, ended } = observedConnection();
    const db = createTenon({ connection: pool });
    try {
      const first = await db.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`, {
        returns: 'one',
      });
      await disconnect(first.pid);
      await ended;
      const next = await db.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`, {
        returns: 'one',
      });
      assert.notEqual(next.pid, first.pid);
    } finally {
      await db.close();
      await pool.close();
    }
  },
);

test(
  'losing one reserved backend leaves a concurrent transaction usable',
  { timeout: 10000 },
  async () => {
    await project({}, async ({ namespace }) => {
      await admin.withSession((session) =>
        session.script(
          `CREATE SCHEMA "${namespace}"; CREATE TABLE ${qualified(namespace, 'writes')} (id integer)`,
        ),
      );
      let closed!: () => void;
      const ended = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const pool = createPool({
        connectionString: testConnection,
        maxConnections: 2,
        onEvent: (event) => {
          if (event.type === 'disconnect') closed();
        },
      });

      const db = createTenon({ connection: pool });
      let proceed!: () => void;
      const resumed = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const pids: Promise<number>[] = [];
      const operations = [1, 2].map((id) => {
        let ready!: (pid: number) => void;
        pids.push(
          new Promise<number>((resolve) => {
            ready = resolve;
          }),
        );
        return db.transaction(async (tx) => {
          const row = await tx.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`, {
            returns: 'one',
          });
          await tx.query(sql`INSERT INTO ${identifier(namespace, 'writes')} VALUES (${id})`);
          ready(row.pid);
          await resumed;
          await tx.query(sql`SELECT 1`);
        });
      });
      const failed = assert.rejects(operations[0]!, lostConnection);
      try {
        const [first, second] = await Promise.all(pids);
        assert.notEqual(first, second);
        await disconnect(first!);
        await ended;
        proceed();
        await Promise.all([failed, operations[1]]);
        assert.deepEqual(
          [
            ...(await admin.queryClassic(`SELECT id FROM ${qualified(namespace, 'writes')}`, []))
              .rows,
          ],
          [{ id: 2 }],
        );
      } finally {
        proceed();
        await db.close();
        await pool.close();
      }
    });
  },
);
