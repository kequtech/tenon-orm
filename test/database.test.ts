import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import type { Transaction } from '../src/index.js';
import tenon, { define, migrate } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import type { User } from './fixtures/generated-schema.js';

import { assertTestDatabase, testConnection as connection } from './helpers/database.js';
const namespace = `tenon_test_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({ connectionString: connection, max: 4 });
const db = tenon({ connection: pool });
const target = qualified(namespace, 'User');
let ownsNamespace = false;

before(async () => {
  await assertTestDatabase(pool);
  ownsNamespace = true;
  await migrate({
    connection: pool,
    directory: new URL('../../test/fixtures/migrations', import.meta.url).pathname,
    namespace,
  });
});
beforeEach(async () => {
  await db.sql<object>(`TRUNCATE ${target} RESTART IDENTITY CASCADE`, [], { returns: 'many' });
});
after(async () => {
  try {
    if (ownsNamespace) await pool.query(`DROP SCHEMA IF EXISTS ${quote(namespace)} CASCADE`);
  } finally {
    await db.close();
    await pool.end();
  }
});

test('inline SQL binds values and preserves database defaults, nulls, dates, UUIDs and enums', async () => {
  const email = "alice'); DROP TABLE users; --";
  const row = await db.sql<User>(`INSERT INTO ${target} (email) VALUES ($1) RETURNING *`, [email], {
    returns: 'requiredOne',
  });
  assert.equal(row.email, email);
  assert.equal(row.active, false);
  assert.equal(row.score, 0);
  assert.equal(row.name, "O'Reilly\\notes");
  assert.equal(row.nickname, null);
  assert.equal(row.role, 'reader');
  assert.ok(row.createdAt instanceof Date);
  assert.match(row.token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    await db.sql<Pick<User, 'email'>>(`SELECT email FROM ${target} WHERE email = $1`, [email], {
      returns: 'many',
    }),
    [{ email }],
  );
});

test('SQL controls projection, filters, ordering, pagination and batch defaults', async () => {
  await db.sql<object>(
    `INSERT INTO ${target} (email, score) VALUES ($1, DEFAULT), ($2, $3), ($4, $5)`,
    ['a', 'b', 2, 'c', 3],
    { returns: 'many' },
  );
  const rows = await db.sql<Pick<User, 'email'>>(
    `SELECT email FROM ${target} WHERE score >= $1 ORDER BY email DESC LIMIT $2 OFFSET $3`,
    [0, 1, 1],
    { returns: 'many' },
  );
  assert.deepEqual(rows, [{ email: 'b' }]);
  assert.deepEqual(
    await db.sql<User>(`SELECT * FROM ${target} WHERE email = $1`, ['absent'], { returns: 'many' }),
    [],
  );
  await assert.rejects(
    db.sql<object>(`INSERT INTO ${target} (email) VALUES ('duplicate'), ('duplicate')`, [], {
      returns: 'many',
    }),
    { code: '23505' },
  );
  assert.deepEqual(
    await db.sql<User>(`SELECT * FROM ${target} WHERE email = 'duplicate'`, [], {
      returns: 'many',
    }),
    [],
  );
});

test('inline one and requiredOne enforce cardinality without changing SQL', async () => {
  const sql = `SELECT id, email FROM ${target} ORDER BY id`;
  type Summary = Pick<User, 'id' | 'email'>;
  assert.equal(await db.sql<Summary>(sql, [], { returns: 'one' }), undefined);
  await assert.rejects(
    db.sql<Summary>(sql, [], { returns: 'requiredOne' }),
    /Inline SQL.*exactly one row.*0 rows/,
  );
  await db.sql<object>(`INSERT INTO ${target} (email) VALUES ('a')`, [], { returns: 'many' });
  assert.deepEqual(await db.sql<Summary>(sql, [], { returns: 'requiredOne' }), {
    id: 1,
    email: 'a',
  });
  await db.sql<object>(`INSERT INTO ${target} (email) VALUES ('b')`, [], { returns: 'many' });
  await assert.rejects(db.sql<Summary>(sql, [], { returns: 'one' }), /at most one row.*2 rows/);
  await assert.rejects(
    db.sql<Summary>(sql, [], { returns: 'requiredOne' }),
    /exactly one row.*2 rows/,
  );
  assert.deepEqual(await db.sql<Summary>(`${sql} LIMIT 1`, [], { returns: 'one' }), {
    id: 1,
    email: 'a',
  });
});

test('inline command results preserve native fields and explicitly requested RETURNING rows', async () => {
  const inserted = await db.sql(`INSERT INTO ${target} (email) VALUES ('a'), ('b')`, [], {
    returns: 'native',
  });
  assert.equal(inserted.command, 'INSERT');
  assert.equal(inserted.rowCount, 2);
  assert.deepEqual(inserted.rows, []);
  assert.deepEqual(inserted.fields, []);
  assert.notEqual(Object.getPrototypeOf(inserted), Object.prototype);
  const changed = await db.sql<Pick<User, 'id' | 'active'>>(
    `UPDATE ${target} SET active = $1 RETURNING id, active`,
    [true],
    { returns: 'native' },
  );
  assert.equal(changed.command, 'UPDATE');
  assert.equal(changed.rowCount, 2);
  assert.deepEqual(
    changed.rows.sort((a, b) => a.id - b.id),
    [
      { id: 1, active: true },
      { id: 2, active: true },
    ],
  );
  assert.deepEqual(
    changed.fields.map((field) => field.name),
    ['id', 'active'],
  );
  const absent = await db.sql<never>(`DELETE FROM ${target} WHERE id = $1`, [-1], {
    returns: 'native',
  });
  assert.equal(absent.rowCount, 0);
  const ddl = await db.sql<never>(
    `CREATE TABLE ${qualified(namespace, 'Scratch')} (id integer)`,
    [],
    { returns: 'native' },
  );
  try {
    assert.equal(ddl.command, 'CREATE');
    assert.equal(ddl.rowCount, null);
  } finally {
    await db.sql<object>(`DROP TABLE ${qualified(namespace, 'Scratch')}`, [], { returns: 'many' });
  }
});

test('native is the default for reads and writes while explicit modes extract only row objects', async () => {
  type ArrayRow = { values: (number | null)[] };
  const sql = 'SELECT ARRAY[1, NULL, 3] AS values';
  const native = await db.sql<ArrayRow>(sql, []);
  assert.equal(native.command, 'SELECT');
  assert.equal(native.rowCount, 1);
  assert.deepEqual(native.rows, [{ values: [1, null, 3] }]);
  assert.equal(native.fields[0]!.name, 'values');
  assert.deepEqual(await db.sql<ArrayRow>(sql, [], { returns: 'many' }), native.rows);
  assert.deepEqual(await db.sql<ArrayRow>(sql, [], { returns: 'one' }), native.rows[0]);
  assert.deepEqual(await db.sql<ArrayRow>(sql, [], { returns: 'requiredOne' }), native.rows[0]);
  // Omitting the row generic restricts static access; it never removes real data.
  assert.deepEqual((await db.sql(sql, [])).rows, native.rows);
  const inserted = await db.sql<never>(`INSERT INTO ${target} (email) VALUES ($1)`, ['native']);
  assert.equal(inserted.command, 'INSERT');
  assert.equal(inserted.rowCount, 1);
  assert.deepEqual(inserted.rows, []);
  const unchangedShape = await db.sql<User>(`SELECT * FROM ${target} WHERE email = 'missing'`, []);
  assert.deepEqual(unchangedShape.rows, []);
  assert.equal(unchangedShape.rowCount, 0);
  assert.equal(
    await db.sql<User>(`UPDATE ${target} SET score = 1`, [], { returns: 'one' }),
    undefined,
  );
  await assert.rejects(
    db.sql<User>(`UPDATE ${target} SET score = 2`, [], { returns: 'requiredOne' }),
    /returned 0 rows/,
  );
});

test('SQL results retain driver values for aggregates, large integers and nested JSON', async () => {
  const result = await db.sql<{
    count: string;
    large: string;
    nested: { values: number[]; missing: null };
  }>(
    `SELECT count(*)::text AS count, 9007199254740993::bigint AS large,
      jsonb_build_object('values', jsonb_build_array(1, 2), 'missing', NULL) AS nested FROM ${target}`,
    [],
    { returns: 'requiredOne' },
  );
  assert.deepEqual(result, {
    count: '0',
    large: '9007199254740993',
    nested: { values: [1, 2], missing: null },
  });
});

test('cardinality checking does not silently limit writes or undo standalone autocommit', async () => {
  await assert.rejects(
    db.sql<User>(`INSERT INTO ${target} (email) VALUES ('a'), ('b') RETURNING *`, [], {
      returns: 'requiredOne',
    }),
    /2 rows/,
  );
  assert.equal((await db.sql<User>(`SELECT * FROM ${target}`, [], { returns: 'many' })).length, 2);
  await assert.rejects(
    db.transaction((tx) =>
      tx.sql<User>(`UPDATE ${target} SET active = true RETURNING *`, [], {
        returns: 'requiredOne',
      }),
    ),
    /2 rows/,
  );
  assert.deepEqual(
    await db.sql<Pick<User, 'active'>>(`SELECT active FROM ${target}`, [], { returns: 'many' }),
    [{ active: false }, { active: false }],
  );
});

test('inline statements use one transaction connection with explicit commit and rollback', async () => {
  const email = await db.transaction(async (tx) => {
    const first = await tx.sql<{ pid: number }>('SELECT pg_backend_pid() AS pid', [], {
      returns: 'requiredOne',
    });
    const second = await tx.sql<{ pid: number }>('SELECT pg_backend_pid() AS pid', [], {
      returns: 'requiredOne',
    });
    assert.equal(first.pid, second.pid);
    const row = await tx.sql<User>(
      `INSERT INTO ${target} (email) VALUES ($1) RETURNING *`,
      ['committed'],
      { returns: 'requiredOne' },
    );
    assert.deepEqual(await db.sql<User>(`SELECT * FROM ${target}`, [], { returns: 'many' }), []);
    return row.email;
  });
  assert.equal(email, 'committed');
  let leaked: Transaction | undefined;
  await assert.rejects(
    db.transaction(async (tx) => {
      leaked = tx;
      await tx.sql<object>(`DELETE FROM ${target}`, [], { returns: 'many' });
      assert.deepEqual(await tx.sql<User>(`SELECT * FROM ${target}`, [], { returns: 'many' }), []);
      throw new Error('cancel');
    }),
    /cancel/,
  );
  assert.equal((await db.sql<User>(`SELECT * FROM ${target}`, [], { returns: 'many' })).length, 1);
  await assert.rejects(
    leaked!.sql<User>(`SELECT * FROM ${target}`, [], { returns: 'many' }),
    /transaction has finished/,
  );
});

test('a caught PostgreSQL error cannot make an aborted transaction report success', async () => {
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.sql<object>(`INSERT INTO ${target} (email) VALUES ('duplicate')`, [], {
        returns: 'many',
      });
      try {
        await tx.sql<object>(`INSERT INTO ${target} (email) VALUES ('duplicate')`, [], {
          returns: 'many',
        });
      } catch {
        /* PostgreSQL has aborted the transaction. */
      }
      return 'must not be reported as committed';
    }),
    /rolled back the aborted transaction/,
  );
  assert.deepEqual(await db.sql<User>(`SELECT * FROM ${target}`, [], { returns: 'many' }), []);
});

test('rejected transaction boundaries cannot commit writes early or abort a caught callback', async () => {
  const client = tenon({
    connection: pool,
    operations: {
      commit: define('; /* ownership */ COMMIT AND CHAIN'),
      rollback: define('ROLLBACK TRANSACTION'),
    },
  });
  try {
    for (const entry of ['sql', 'run'] as const) {
      await assert.rejects(
        client.transaction(async (tx) => {
          await tx.sql(`INSERT INTO ${target} (email) VALUES ($1)`, [entry]);
          if (entry === 'sql') await tx.sql('COMMIT', []);
          else await tx.run('commit', []);
        }),
        /cannot start or end a transaction/,
      );
    }
    assert.deepEqual((await db.sql<User>(`SELECT * FROM ${target}`, [])).rows, []);
    await client.transaction(async (tx) => {
      await tx.sql(`INSERT INTO ${target} (email) VALUES ('kept')`, []);
      await assert.rejects(tx.sql('COMMIT', []), /cannot start or end a transaction/);
      await assert.rejects(tx.run('rollback', []), /cannot start or end a transaction/);
      await tx.sql(`INSERT INTO ${target} (email) VALUES ('after rejection')`, []);
    });
    const result = await db.sql<Pick<User, 'email'>>(
      `SELECT email FROM ${target} ORDER BY email`,
      [],
      { returns: 'many' },
    );
    assert.deepEqual(result, [{ email: 'after rejection' }, { email: 'kept' }]);
  } finally {
    await client.close();
  }
});

test('inline and named isolation and savepoint SQL preserve the callback transaction', async () => {
  const client = tenon({
    connection: pool,
    operations: {
      isolation: define('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'),
      savepoint: define('SAVEPOINT recovery'),
      rollback_to: define('ROLLBACK /* comment */ TRANSACTION TO SAVEPOINT recovery'),
      release: define('RELEASE SAVEPOINT recovery'),
    },
  });
  try {
    await client.transaction(async (tx) => {
      await tx.run('isolation', []);
      const settings = await tx.sql<{ transaction_isolation: string }>(
        'SHOW transaction_isolation',
        [],
        { returns: 'requiredOne' },
      );
      assert.equal(settings.transaction_isolation, 'repeatable read');
      await tx.sql(`INSERT INTO ${target} (email) VALUES ('kept')`, []);
      await tx.run('savepoint', []);
      // Recover from a real PostgreSQL error without aborting the outer work.
      await assert.rejects(tx.sql(`INSERT INTO ${target} (email) VALUES ('kept')`, []), {
        code: '23505',
      });
      await tx.run('rollback_to', []);
      await tx.run('release', []);
      await tx.sql('SAVEPOINT "COMMIT"', []);
      await tx.sql(`INSERT INTO ${target} (email) VALUES ('discarded')`, []);
      await tx.sql('ROLLBACK WORK TO SAVEPOINT "COMMIT"', []);
      await tx.sql('RELEASE SAVEPOINT "COMMIT"', []);
      await tx.sql(`INSERT INTO ${target} (email) VALUES ('after recovery')`, []);
    });
    const rows = await db.sql<Pick<User, 'email'>>(
      `SELECT email FROM ${target} ORDER BY email`,
      [],
      { returns: 'many' },
    );
    assert.deepEqual(rows, [{ email: 'after recovery' }, { email: 'kept' }]);
    // Inline isolation settings also work, and don't leak to the next transaction.
    await client.transaction(async (tx) => {
      await tx.sql('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY', []);
      const settings = await tx.sql<{ transaction_isolation: string }>(
        'SHOW transaction_isolation',
        [],
        { returns: 'requiredOne' },
      );
      assert.equal(settings.transaction_isolation, 'serializable');
    });
    await client.transaction(async (tx) => {
      await tx.sql(`INSERT INTO ${target} (email) VALUES ('next transaction')`, []);
    });
  } finally {
    await client.close();
  }
});

test('transaction words in values, identifiers and SQL bodies pass through unchanged', async () => {
  const client = tenon({
    connection: pool,
    operations: {
      echo: define<{ COMMIT: string }, [value: string]>('SELECT $1::text AS "COMMIT"'),
      body: define("DO $body$ BEGIN RAISE NOTICE 'COMMIT; ROLLBACK;'; END $body$"),
    },
  });
  try {
    await assert.rejects(
      client.transaction(async (tx) => {
        const inline = await tx.sql<{ BEGIN: string; END: string }>(
          `/* COMMIT */ SELECT 'ROLLBACK; COMMIT;' AS "BEGIN", $body$BEGIN; END;$body$ AS "END"`,
          [],
        );
        assert.deepEqual(inline.rows, [{ BEGIN: 'ROLLBACK; COMMIT;', END: 'BEGIN; END;' }]);
        assert.deepEqual((await tx.run('echo', ['PREPARE TRANSACTION'])).rows, [
          { COMMIT: 'PREPARE TRANSACTION' },
        ]);
        await tx.run('body', []);
        await tx.sql(`DO $body$ BEGIN RAISE NOTICE 'END;'; END $body$`, []);
        for (const prepared of [
          {
            sql: 'PREPARE transaction AS SELECT 1 AS value',
            execute: 'EXECUTE transaction',
            value: 1,
          },
          {
            sql: 'PREPARE transaction(integer) AS SELECT $1 AS value',
            execute: 'EXECUTE transaction(7)',
            value: 7,
          },
        ]) {
          await tx.sql(prepared.sql, []);
          try {
            assert.deepEqual((await tx.sql<{ value: number }>(prepared.execute, [])).rows, [
              { value: prepared.value },
            ]);
          } finally {
            await tx.sql('DEALLOCATE transaction', []);
          }
        }
        await assert.rejects(tx.sql('SELECT FROM', []), { code: '42601' });
        // The native syntax error leaves the transaction aborted as usual.
        throw new Error('syntax failure');
      }),
      /syntax failure/,
    );
  } finally {
    await client.close();
  }
});

test('PostgreSQL errors retain constraint details and foreign-key actions', async () => {
  await assert.rejects(
    db.sql<object>(
      `INSERT INTO ${qualified(namespace, 'Post')} ("userId", title) VALUES ($1, $2)`,
      [99, 'orphan'],
      { returns: 'many' },
    ),
    { code: '23503', table: 'Post' },
  );
  const user = await db.sql<User>(
    `INSERT INTO ${target} (email) VALUES ('parent') RETURNING *`,
    [],
    { returns: 'requiredOne' },
  );
  await db.sql<object>(
    `INSERT INTO ${qualified(namespace, 'Post')} ("userId", title) VALUES ($1, $2)`,
    [user.id, 'child'],
    { returns: 'many' },
  );
  await db.sql<object>(`DELETE FROM ${target} WHERE id = $1`, [user.id], { returns: 'many' });
  assert.deepEqual(
    await db.sql<object>(`SELECT * FROM ${qualified(namespace, 'Post')}`, [], { returns: 'many' }),
    [],
  );
});

test('one inline call executes one statement, including calls with no parameters', async () => {
  await assert.rejects(
    db.sql<object>(`INSERT INTO ${target} (email) VALUES ('unexpected'); SELECT 1`, [], {
      returns: 'many',
    }),
    /multiple commands/,
  );
  assert.deepEqual(await db.sql<User>(`SELECT * FROM ${target}`, [], { returns: 'many' }), []);
  await assert.rejects(
    db.sql<object>('SELECT $1::text', [], { returns: 'many' }),
    /bind message supplies 0 parameters/,
  );
  await assert.rejects(db.sql<object>('SELECT missing_column', [], { returns: 'many' }), {
    code: '42703',
  });
});

test('invalid inline SQL options and non-array inputs reject before execution', async () => {
  const unchecked = db.sql as (
    sql: unknown,
    input?: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  for (const sql of ['', '  ', null, 1])
    await assert.rejects(unchecked(sql, []), /nonempty string/);
  for (const input of [undefined, null, {}, 'value'])
    await assert.rejects(unchecked('SELECT 1', input), /explicit array/);
  for (const options of [null, [], { returns: 'first' }, { limit: 1 }]) {
    await assert.rejects(
      unchecked('SELECT 1', [], options),
      /plain object|Unknown operation option|Operation returns/,
    );
  }
});

test('close respects pool ownership and rejects subsequent SQL and transactions', async () => {
  const borrowed = tenon({ connection: pool });
  await borrowed.close();
  await borrowed.close();
  await assert.rejects(borrowed.sql<object>('SELECT 1', [], { returns: 'many' }), /closed/);
  await assert.rejects(
    borrowed.transaction(async () => {}),
    /closed/,
  );
  assert.deepEqual(await db.sql<{ value: number }>('SELECT 1 AS value', [], { returns: 'many' }), [
    { value: 1 },
  ]);
  const owned = tenon({ connection });
  assert.deepEqual(
    await owned.sql<{ value: number }>('SELECT 2 AS value', [], { returns: 'many' }),
    [{ value: 2 }],
  );
  await owned.close();
  await assert.rejects(owned.sql<object>('SELECT 1', [], { returns: 'many' }), /closed/);
});
