// Copy to test/database.test.ts in an ESM app; run with node --test test/database.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AffectedRowsError, createTenon, sql, type Transaction } from '@kequtech/tenon-orm';

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith('_test'))
  throw new Error('Set TEST_DATABASE_URL to a dedicated database ending in _test.');

test('a failed write guard rolls back its statement and the transaction expires after completion', async () => {
  const db = createTenon({ connection });
  let expired: Transaction | undefined;
  try {
    await db.transaction(async (tx) => {
      expired = tx;
      await tx.query(sql`CREATE TEMP TABLE example_users (
        id integer PRIMARY KEY, active boolean NOT NULL
      ) ON COMMIT DROP`);
      await tx.query(sql`INSERT INTO example_users VALUES (1, true), (2, true)`);
      await assert.rejects(
        tx.query(sql`UPDATE example_users SET active=false`, { affectedRows: { exact: 1 } }),
        AffectedRowsError,
      );
      assert.deepEqual(
        await tx.query(
          sql<{ id: number; active: boolean }>`
        SELECT id, active FROM example_users ORDER BY id`,
          { returns: 'many' },
        ),
        [
          { id: 1, active: true },
          { id: 2, active: true },
        ],
      );
      await tx.query(sql`UPDATE example_users SET active=false WHERE id=${1}`, {
        affectedRows: { exact: 1 },
      });
      assert.deepEqual(
        await tx.query(sql<{ active: boolean }>`SELECT active FROM example_users WHERE id=${1}`, {
          returns: 'one',
        }),
        { active: false },
      );
    });
    await assert.rejects(expired!.query(sql`SELECT 1`), /transaction has finished/);
  } finally {
    await db.close();
  }
});
