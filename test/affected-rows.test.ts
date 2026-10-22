import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import type { OperationOptions, Transaction } from '../src/index.js';
import {
  AffectedRowsError,
  createTenon,
  defineOperation,
  identifier,
  sql,
  TenonError,
  unsafeSql,
} from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const namespace = `tenon_test_${randomUUID().replaceAll('-', '')}`;
const table = qualified(namespace, 'items');
const pool = new Pool({ connectionString: testConnection });
const db = createTenon({ connection: pool });
let ownsNamespace = false;

before(async () => {
  await assertTestDatabase(pool);
  await pool.query(`CREATE SCHEMA ${quote(namespace)}`);
  ownsNamespace = true;
  await pool.query(
    `CREATE TABLE ${table} (id integer PRIMARY KEY, value integer NOT NULL DEFAULT 0)`,
  );
});
beforeEach(async () => {
  await pool.query(`TRUNCATE ${table}`);
  await pool.query(`INSERT INTO ${table} (id) VALUES (1), (2)`);
});
after(async () => {
  try {
    if (ownsNamespace) await pool.query(`DROP SCHEMA ${quote(namespace)} CASCADE`);
  } finally {
    await db.close();
    await pool.end();
  }
});

const rows = (client: Transaction = db) =>
  client.query(
    sql<{ id: number; value: number }>`SELECT * FROM ${identifier(namespace, 'items')} ORDER BY id`,
    {
      returns: 'many',
    },
  );

test('max permits zero or one match and rolls back an overbroad UPDATE without RETURNING', async () => {
  const update = defineOperation(
    (id: number) =>
      sql`UPDATE ${identifier(namespace, 'items')} SET value = value + 1 WHERE id = ${id}`,
    { affectedRows: { max: 1 } },
  );
  assert.equal((await db.run(update, [-1])).rowCount, 0);
  assert.equal((await db.run(update, [1])).rowCount, 1);
  await assert.rejects(
    db.query(sql`UPDATE ${identifier(namespace, 'items')} SET value = value + 10`, {
      affectedRows: { max: 1 },
    }),
    (error) => {
      assert.ok(error instanceof AffectedRowsError);
      assert.equal(error.code, 'TENON_AFFECTED_ROWS_MISMATCH');
      assert.deepEqual(error.expected, { max: 1 });
      assert.equal(error.actual, 2);
      assert.equal(error.command, 'UPDATE');
      return true;
    },
  );
  assert.deepEqual(await rows(), [
    { id: 1, value: 1 },
    { id: 2, value: 0 },
  ]);
});

test('exact enforces zero, one and multiple matches independently of result mode', async () => {
  const remove = defineOperation(
    (id: number) => sql`DELETE FROM ${identifier(namespace, 'items')} WHERE id = ${id}`,
    {
      affectedRows: { exact: 1 },
    },
  );
  await assert.rejects(db.run(remove, [-1]), /exactly 1 affected rows.*reported 0/);
  await assert.rejects(
    db.query(sql`DELETE FROM ${identifier(namespace, 'items')}`, {
      returns: 'many',
      affectedRows: { exact: 1 },
    }),
    /reported 2/,
  );
  assert.equal((await rows()).length, 2);
  const changed = await db.query(
    sql<{ id: number }>`UPDATE ${identifier(namespace, 'items')} SET value = 5 RETURNING id`,
    {
      returns: 'many',
      affectedRows: { exact: 2 },
    },
  );
  assert.equal(changed.length, 2);
  // UPDATE counts matched rows even when the assigned value was already stored.
  assert.equal(
    (
      await db.query(sql`UPDATE ${identifier(namespace, 'items')} SET value = 5`, {
        affectedRows: { exact: 2 },
      })
    ).rowCount,
    2,
  );
  assert.equal(
    (
      await db.query(sql`DELETE FROM ${identifier(namespace, 'items')} WHERE false`, {
        affectedRows: { exact: 0 },
      })
    ).rowCount,
    0,
  );
  await assert.rejects(
    db.query(sql`DELETE FROM ${identifier(namespace, 'items')} WHERE id = 1`, {
      affectedRows: { max: 0 },
    }),
    /at most 0 affected rows/,
  );
  assert.equal((await db.run(remove, [1])).rowCount, 1);
});

test('guarded INSERT and MERGE roll back rejected writes', async () => {
  await assert.rejects(
    db.query(sql`INSERT INTO ${identifier(namespace, 'items')} (id) VALUES (3), (4)`, {
      affectedRows: { exact: 1 },
    }),
    /reported 2/,
  );
  const merge = `MERGE INTO ${table} t USING (VALUES (1), (3)) AS s(id)
    ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET value = 9
    WHEN NOT MATCHED THEN INSERT (id, value) VALUES (s.id, 9)`;
  await assert.rejects(db.query(unsafeSql(merge, []), { affectedRows: { max: 1 } }), /reported 2/);
  assert.deepEqual(await rows(), [
    { id: 1, value: 0 },
    { id: 2, value: 0 },
  ]);
  assert.equal((await db.query(unsafeSql(merge, []), { affectedRows: { exact: 2 } })).rowCount, 2);
});

test('caught constraint and SQL errors recover locally while surrounding writes commit', async () => {
  await db.transaction(async (tx) => {
    await tx.query(sql`UPDATE ${identifier(namespace, 'items')} SET value = 1 WHERE id = 1`);
    await assert.rejects(
      tx.query(sql`DELETE FROM ${identifier(namespace, 'items')}`, {
        affectedRows: { max: 1 },
      }),
      /reported 2/,
    );
    await assert.rejects(
      tx.query(sql`INSERT INTO ${identifier(namespace, 'items')} (id) VALUES (1)`, {
        affectedRows: { exact: 1 },
      }),
      { code: '23505' },
    );
    await tx.query(sql`UPDATE ${identifier(namespace, 'items')} SET value = 2 WHERE id = 2`, {
      affectedRows: { exact: 1 },
    });
  });
  assert.deepEqual(await rows(), [
    { id: 1, value: 1 },
    { id: 2, value: 2 },
  ]);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(sql`UPDATE ${identifier(namespace, 'items')} SET value = 99 WHERE id = 1`);
      await tx.query(sql`DELETE FROM ${identifier(namespace, 'items')}`, {
        affectedRows: { max: 1 },
      });
    }),
    /reported 2/,
  );
  assert.deepEqual(await rows(), [
    { id: 1, value: 1 },
    { id: 2, value: 2 },
  ]);
});

test('result cardinality validation happens inside the guarded rollback boundary', async () => {
  const invalid = defineOperation(
    () =>
      sql<{
        id: number;
      }>`INSERT INTO ${identifier(namespace, 'items')} (id) VALUES (3), (4) RETURNING id`,
    {
      returns: 'one',
      affectedRows: { max: 2 },
    },
  );
  await assert.rejects(db.run(invalid, []), /returned 2 rows/);
  await db.transaction(async (tx) => {
    await assert.rejects(tx.run(invalid, []), /returned 2 rows/);
    await tx.query(sql`INSERT INTO ${identifier(namespace, 'items')} (id) VALUES (5)`);
  });
  assert.deepEqual(
    (await rows()).map((r) => r.id),
    [1, 2, 5],
  );
});

test('concurrent guarded and unguarded calls cannot cross savepoint boundaries', async () => {
  await db.transaction(async (tx) => {
    const results = await Promise.allSettled([
      tx.query(sql`UPDATE ${identifier(namespace, 'items')} SET value = 99`, {
        affectedRows: { max: 1 },
      }),
      tx.query(sql`INSERT INTO ${identifier(namespace, 'items')} (id) VALUES (3)`),
      tx.query(sql`UPDATE ${identifier(namespace, 'items')} SET value = 8 WHERE id = 1`, {
        affectedRows: { exact: 1 },
      }),
      tx.query(sql`DELETE FROM ${identifier(namespace, 'items')}`, { affectedRows: { exact: 1 } }),
      tx.query(sql`INSERT INTO ${identifier(namespace, 'items')} (id) VALUES (4)`, {
        affectedRows: { max: 1 },
      }),
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      ['rejected', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled'],
    );
  });
  assert.deepEqual(await rows(), [
    { id: 1, value: 8 },
    { id: 2, value: 0 },
    { id: 3, value: 0 },
    { id: 4, value: 0 },
  ]);
});

test('unsupported command counts reject and roll back, including writes in a final SELECT CTE', async () => {
  for (const sql of [
    'SELECT 1',
    `TRUNCATE ${table}`,
    `WITH deleted AS (DELETE FROM ${table} RETURNING *) SELECT * FROM deleted`,
  ]) {
    await assert.rejects(
      db.query(unsafeSql(sql, []), { affectedRows: { max: 10 } }),
      /requires an INSERT, UPDATE, DELETE, or MERGE command count/,
    );
    assert.equal((await rows()).length, 2);
  }
  await db.transaction(async (tx) => {
    await assert.rejects(
      tx.query(sql`TRUNCATE ${identifier(namespace, 'items')}`, { affectedRows: { exact: 0 } }),
      /requires an INSERT/,
    );
    assert.equal((await rows(tx)).length, 2);
  });
});

test('the constraint checks only the final command count, not other CTE writes', async () => {
  const result = await db.query(
    sql`WITH changed AS (UPDATE ${identifier(namespace, 'items')} SET value = 7 RETURNING id)
     INSERT INTO ${identifier(namespace, 'items')} (id) VALUES (3)`,
    { affectedRows: { exact: 1 } },
  );
  assert.equal(result.rowCount, 1);
  assert.deepEqual(await rows(), [
    { id: 1, value: 7 },
    { id: 2, value: 7 },
    { id: 3, value: 0 },
  ]);
});

test('constraint options are validated before execution and captured immutably', async () => {
  const uncheckedDefine = defineOperation as (
    build: () => ReturnType<typeof sql>,
    options: unknown,
  ) => unknown;
  const uncheckedSql = db.query as (query: unknown, options: unknown) => Promise<unknown>;
  for (const affectedRows of [
    null,
    [],
    1,
    {},
    { min: 1 },
    { max: 1, exact: 1 },
    { max: 1, extra: true },
    { max: -1 },
    { exact: 1.5 },
    { max: NaN },
    { exact: Infinity },
    { max: Number.MAX_SAFE_INTEGER + 1 },
    { max: '1' },
    { exact: undefined },
  ]) {
    assert.throws(
      () =>
        uncheckedDefine(() => sql`DELETE FROM ${identifier(namespace, 'items')}`, { affectedRows }),
      TenonError,
    );
    await assert.rejects(
      uncheckedSql(sql`DELETE FROM ${identifier(namespace, 'items')}`, { affectedRows }),
      TenonError,
    );
  }
  const options = { affectedRows: { max: 1 } } satisfies OperationOptions;
  const operation = defineOperation(
    () => sql`DELETE FROM ${identifier(namespace, 'items')}`,
    options,
  );
  Object.assign(options.affectedRows!, { max: 100 });
  assert.ok(Object.isFrozen(operation.options.affectedRows));
  assert.deepEqual(operation.options.affectedRows, { max: 1 });
  await assert.rejects(db.run(operation, []), /reported 2/);
  assert.equal((await rows()).length, 2);
});
