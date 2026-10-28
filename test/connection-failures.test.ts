import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createTenon, identifier, sql } from '../src/index.js';
import { withMigrationLock } from '../src/migrations/connection.js';
import { qualified } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const admin = new Pool({ connectionString: testConnection });
const project = migrationProject(admin);
before(() => assertTestDatabase(admin));
after(() => admin.end());
function observedConnection() {
  let closed!: () => void;
  const ended = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const pool = new Pool({ connectionString: testConnection, max: 1 });
  pool.on('connect', (client) => client.once('end', closed));
  pool.on('error', () => {});
  return { pool, ended };
}
async function disconnect(pid: number) {
  const [row] = (await admin.query('SELECT pg_terminate_backend($1) AS stopped', [pid])).rows;
  assert.equal(row!.stopped, true);
}
function lostConnection(error: unknown): boolean {
  assert.ok(error instanceof AggregateError);
  assert.match(error.errors[0].message, /connection|terminat/i);
  assert.equal(error.errors.length, 2);
  return true;
}

test(
  'a backend lost between transaction queries rejects, rolls back writes and permits a fresh connection',
  { timeout: 10000 },
  async () => {
    await project({}, async ({ namespace }) => {
      const target = qualified(namespace, 'writes');
      await admin.query(`CREATE SCHEMA "${namespace}"; CREATE TABLE ${target} (id integer)`);
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
              /connection|terminat/i,
            );
            return 'must not succeed';
          }),
          lostConnection,
        );
        assert.equal((await admin.query(`SELECT * FROM ${target}`)).rows.length, 0);
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
  'tools preserve a backend failure between queries and release its advisory lock',
  { timeout: 10000 },
  async () => {
    await project({}, async ({ namespace }) => {
      const { pool, ended } = observedConnection();
      try {
        await assert.rejects(
          withMigrationLock({ connection: pool, namespace }, 'exclusive', async (client) => {
            const [row] = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
              .rows;
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
        await pool.end();
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
      await pool.end();
    }
  },
);

test(
  'losing one reserved backend leaves a concurrent transaction usable',
  { timeout: 10000 },
  async () => {
    await project({}, async ({ namespace }) => {
      await admin.query(
        `CREATE SCHEMA "${namespace}"; CREATE TABLE ${qualified(namespace, 'writes')} (id integer)`,
      );
      let closed!: () => void;
      const ended = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const pool = new Pool({ connectionString: testConnection, max: 2 });
      pool.on('connect', (client) => client.once('end', closed));
      pool.on('error', () => {});
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
          [...(await admin.query(`SELECT id FROM ${qualified(namespace, 'writes')}`)).rows],
          [{ id: 2 }],
        );
      } finally {
        proceed();
        await db.close();
        await pool.end();
      }
    });
  },
);
