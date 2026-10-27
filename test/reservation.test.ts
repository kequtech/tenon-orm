import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import postgres from 'postgres';
import { createTenon, sql } from '../src/index.js';
import { withMigrationLock } from '../src/migrations/connection.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const admin = postgres(testConnection);
before(() => assertTestDatabase(admin));
after(() => admin.end());

for (const fetch_types of [true, false]) {
  test(
    `a cold client reserves concurrent transaction sessions with fetch_types=${fetch_types}`,
    { timeout: 10000 },
    async (t) => {
      const debug = t.mock.fn();
      const driver = postgres(testConnection, { max: 3, fetch_types, debug });
      const db = createTenon({ connection: driver });
      t.after(async () => {
        await db.close();
        await driver.end({ timeout: 1 });
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
      assert.equal(driver.options.debug, debug, 'bootstrap must restore the caller debug hook');
      const previousCalls = debug.mock.callCount();
      await db.transaction(async (tx) => {
        assert.equal(
          (await tx.query(sql<{ value: number }>`SELECT 42 AS value`, { returns: 'one' })).value,
          42,
        );
      });
      assert.ok(debug.mock.callCount() > previousCalls);
      assert.equal(driver.options.debug, debug);
    },
  );

  test(
    `a cold client can acquire and release a tooling lock with fetch_types=${fetch_types}`,
    { timeout: 10000 },
    async (t) => {
      const driver = postgres(testConnection, { max: 1, fetch_types });
      t.after(() => driver.end({ timeout: 1 }));
      const options = { connection: driver, namespace: 'tenon_cold_reservation' };
      assert.equal(
        await withMigrationLock(options, 'exclusive', async (client) => {
          const [row] = await client.unsafe<{ value: number }[]>('SELECT 42 AS value');
          return row!.value;
        }),
        42,
      );
      assert.equal(
        await withMigrationLock(options, 'exclusive', async () => 'reacquired'),
        'reacquired',
      );
    },
  );
}
