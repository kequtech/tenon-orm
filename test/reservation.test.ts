import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createTenon, sql } from '../src/index.js';
import { withMigrationLock } from '../src/migrations/connection.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const admin = new Pool({ connectionString: testConnection });
before(() => assertTestDatabase(admin));
after(() => admin.end());

test(`a cold client reserves concurrent transaction sessions`, { timeout: 10000 }, async (t) => {
  const driver = new Pool({ connectionString: testConnection, max: 3 });
  const db = createTenon({ connection: driver });
  t.after(async () => {
    await db.close();
    await driver.end();
  });
  let entered = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pids = await Promise.all(
    Array.from({ length: 3 }, () =>
      db.transaction(async (tx) => {
        const row = await tx.query(
          sql<{ pid: number; xid: string }>`SELECT pg_backend_pid() AS pid,
        pg_current_xact_id()::text AS xid`,
          { returns: 'one' },
        );
        if (++entered === 3) release();
        await ready;
        const same = await tx.query(
          sql<{
            pid: number;
            xid: string;
          }>`SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid`,
          {
            returns: 'one',
          },
        );
        assert.equal(same.pid, row.pid);
        assert.equal(same.xid, row.xid);
        return row.pid;
      }),
    ),
  );
  assert.equal(new Set(pids).size, 3, 'each active transaction must have its own backend');
  await db.transaction(async (tx) => {
    assert.equal(
      (await tx.query(sql<{ value: number }>`SELECT 42 AS value`, { returns: 'one' })).value,
      42,
    );
  });
});

test(`a cold client can acquire and release a tooling lock`, { timeout: 10000 }, async (t) => {
  const driver = new Pool({ connectionString: testConnection, max: 1 });
  t.after(() => driver.end());
  const options = { connection: driver, namespace: 'tenon_cold_reservation' };
  assert.equal(
    await withMigrationLock(options, 'exclusive', async (client) => {
      const [row] = (await client.query<{ value: number }>('SELECT 42 AS value')).rows;
      return row!.value;
    }),
    42,
  );
  assert.equal(
    await withMigrationLock(options, 'exclusive', async () => 'reacquired'),
    'reacquired',
  );
});
