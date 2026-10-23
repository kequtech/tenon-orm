import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import type { Transaction, SqlQuery, OperationReturnMode } from '../src/index.js';
import { createTenon, defineOperation, identifier, migrate, sql, unsafeSql } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import type { User } from './fixtures/generated-schema.js';

import { assertTestDatabase, testConnection as connection } from './helpers/database.js';
const namespace = `tenon_test_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({ connectionString: connection, max: 4 });
const db = createTenon({ connection: pool });
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
  await db.query(sql`TRUNCATE ${identifier(namespace, 'User')} RESTART IDENTITY CASCADE`, {
    returns: 'many',
  });
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
  const row = await db.query(
    sql<User>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${email}) RETURNING *`,
    {
      returns: 'one',
    },
  );
  assert.equal(row.email, email);
  assert.equal(row.active, false);
  assert.equal(row.score, 0);
  assert.equal(row.name, "O'Reilly\\notes");
  assert.equal(row.nickname, null);
  assert.equal(row.role, 'reader');
  assert.ok(row.createdAt instanceof Date);
  assert.match(row.token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    await db.query(
      sql<
        Pick<User, 'email'>
      >`SELECT email FROM ${identifier(namespace, 'User')} WHERE email = ${email}`,
      {
        returns: 'many',
      },
    ),
    [{ email }],
  );
});

test('SQL controls projection, filters, ordering, pagination and batch defaults', async () => {
  await db.query(
    sql`INSERT INTO ${identifier(namespace, 'User')} (email, score) VALUES (${'a'}, DEFAULT), (${'b'}, ${2}), (${'c'}, ${3})`,
    { returns: 'many' },
  );
  const rows = await db.query(
    sql<
      Pick<User, 'email'>
    >`SELECT email FROM ${identifier(namespace, 'User')} WHERE score >= ${0} ORDER BY email DESC LIMIT ${1} OFFSET ${1}`,
    { returns: 'many' },
  );
  assert.deepEqual(rows, [{ email: 'b' }]);
  assert.deepEqual(
    await db.query(
      sql<User>`SELECT * FROM ${identifier(namespace, 'User')} WHERE email = ${'absent'}`,
      { returns: 'many' },
    ),
    [],
  );
  await assert.rejects(
    db.query(
      sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('duplicate'), ('duplicate')`,
      {
        returns: 'many',
      },
    ),
    { code: '23505' },
  );
  assert.deepEqual(
    await db.query(
      sql<User>`SELECT * FROM ${identifier(namespace, 'User')} WHERE email = 'duplicate'`,
      {
        returns: 'many',
      },
    ),
    [],
  );
});

for (const method of ['query', 'run'] as const) {
  test(`${method}: result modes preserve nulls and enforce returned-row counts`, async () => {
    type Summary = Pick<User, 'id' | 'email' | 'nickname'>;
    const query = sql<Summary>`SELECT id, email, nickname FROM ${identifier(namespace, 'User')} ORDER BY id`;
    const execute = (statement: SqlQuery<Summary>, returns: OperationReturnMode) =>
      method === 'query'
        ? db.query(statement, { returns })
        : db.run(
            defineOperation(() => statement, { returns }),
            [],
          );

    assert.deepEqual(await execute(query, 'many'), []);
    assert.equal(await execute(query, 'oneOrNone'), undefined);
    await assert.rejects(execute(query, 'one'), /exactly one row.*0 rows/);

    await db.query(sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('a')`);
    const first = { id: 1, email: 'a', nickname: null };
    assert.deepEqual(await execute(query, 'one'), first);
    assert.deepEqual(await execute(query, 'oneOrNone'), first);

    await db.query(sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('b')`);
    assert.deepEqual(await execute(query, 'many'), [first, { id: 2, email: 'b', nickname: null }]);
    await assert.rejects(execute(query, 'oneOrNone'), /at most one row.*2 rows/);
    await assert.rejects(execute(query, 'one'), /exactly one row.*2 rows/);
    const limited = sql<Summary>`SELECT id, email, nickname FROM ${identifier(namespace, 'User')} ORDER BY id LIMIT 1`;
    assert.deepEqual(await execute(limited, 'oneOrNone'), first);
  });
}

test('inline command results preserve native fields and explicitly requested RETURNING rows', async () => {
  const inserted = await db.query(
    sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('a'), ('b')`,
    {
      returns: 'native',
    },
  );
  assert.equal(inserted.command, 'INSERT');
  assert.equal(inserted.rowCount, 2);
  assert.deepEqual(inserted.rows, []);
  assert.deepEqual(inserted.fields, []);
  assert.notEqual(Object.getPrototypeOf(inserted), Object.prototype);
  const changed = await db.query(
    sql<
      Pick<User, 'id' | 'active'>
    >`UPDATE ${identifier(namespace, 'User')} SET active = ${true} RETURNING id, active`,
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
  const absent = await db.query(
    sql`DELETE FROM ${identifier(namespace, 'User')} WHERE id = ${-1}`,
    {
      returns: 'native',
    },
  );
  assert.equal(absent.rowCount, 0);
  const ddl = await db.query(sql`CREATE TABLE ${identifier(namespace, 'Scratch')} (id integer)`, {
    returns: 'native',
  });
  try {
    assert.equal(ddl.command, 'CREATE');
    assert.equal(ddl.rowCount, null);
  } finally {
    await db.query(sql`DROP TABLE ${identifier(namespace, 'Scratch')}`, { returns: 'many' });
  }
});

test('native is the default for reads and writes while explicit modes extract only row objects', async () => {
  type ArrayRow = { values: (number | null)[] };
  const text = 'SELECT ARRAY[1, NULL, 3] AS values';
  const native = await db.query(unsafeSql<ArrayRow>(text, []));
  assert.equal(native.command, 'SELECT');
  assert.equal(native.rowCount, 1);
  assert.deepEqual(native.rows, [{ values: [1, null, 3] }]);
  assert.equal(native.fields[0]!.name, 'values');
  assert.deepEqual(await db.query(unsafeSql<ArrayRow>(text, []), { returns: 'many' }), native.rows);
  assert.deepEqual(
    await db.query(unsafeSql<ArrayRow>(text, []), { returns: 'oneOrNone' }),
    native.rows[0],
  );
  assert.deepEqual(
    await db.query(unsafeSql<ArrayRow>(text, []), { returns: 'one' }),
    native.rows[0],
  );
  // Omitting the row generic restricts static access; it never removes real data.
  assert.deepEqual((await db.query(unsafeSql(text, []))).rows, native.rows);
  const inserted = await db.query(
    sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${'native'})`,
  );
  assert.equal(inserted.command, 'INSERT');
  assert.equal(inserted.rowCount, 1);
  assert.deepEqual(inserted.rows, []);
  const unchangedShape = await db.query(
    sql<User>`SELECT * FROM ${identifier(namespace, 'User')} WHERE email = 'missing'`,
  );
  assert.deepEqual(unchangedShape.rows, []);
  assert.equal(unchangedShape.rowCount, 0);
  assert.equal(
    await db.query(sql<User>`UPDATE ${identifier(namespace, 'User')} SET score = 1`, {
      returns: 'oneOrNone',
    }),
    undefined,
  );
  await assert.rejects(
    db.query(sql<User>`UPDATE ${identifier(namespace, 'User')} SET score = 2`, { returns: 'one' }),
    /returned 0 rows/,
  );
});

test('SQL results retain driver values for aggregates, large integers and nested JSON', async () => {
  const result = await db.query(
    sql<{
      count: string;
      large: string;
      nested: { values: number[]; missing: null };
    }>`SELECT count(*)::text AS count, 9007199254740993::bigint AS large,
      jsonb_build_object('values', jsonb_build_array(1, 2), 'missing', NULL) AS nested FROM ${identifier(namespace, 'User')}`,
    { returns: 'one' },
  );
  assert.deepEqual(result, {
    count: '0',
    large: '9007199254740993',
    nested: { values: [1, 2], missing: null },
  });
});

test('cardinality checking does not silently limit writes or undo standalone autocommit', async () => {
  await assert.rejects(
    db.query(
      sql<User>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('a'), ('b') RETURNING *`,
      {
        returns: 'one',
      },
    ),
    /2 rows/,
  );
  assert.equal(
    (await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')}`, { returns: 'many' }))
      .length,
    2,
  );
  await assert.rejects(
    db.transaction((tx) =>
      tx.query(sql<User>`UPDATE ${identifier(namespace, 'User')} SET active = true RETURNING *`, {
        returns: 'one',
      }),
    ),
    /2 rows/,
  );
  assert.deepEqual(
    await db.query(sql<Pick<User, 'active'>>`SELECT active FROM ${identifier(namespace, 'User')}`, {
      returns: 'many',
    }),
    [{ active: false }, { active: false }],
  );
});

test('inline statements use one transaction connection with explicit commit and rollback', async () => {
  const email = await db.transaction(async (tx) => {
    const first = await tx.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`, {
      returns: 'one',
    });
    const second = await tx.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`, {
      returns: 'one',
    });
    assert.equal(first.pid, second.pid);
    const row = await tx.query(
      sql<User>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${'committed'}) RETURNING *`,
      { returns: 'one' },
    );
    assert.deepEqual(
      await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')}`, {
        returns: 'many',
      }),
      [],
    );
    return row.email;
  });
  assert.equal(email, 'committed');
  let leaked: Transaction | undefined;
  await assert.rejects(
    db.transaction(async (tx) => {
      leaked = tx;
      await tx.query(sql`DELETE FROM ${identifier(namespace, 'User')}`, { returns: 'many' });
      assert.deepEqual(
        await tx.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')}`, {
          returns: 'many',
        }),
        [],
      );
      throw new Error('cancel');
    }),
    /cancel/,
  );
  assert.equal(
    (await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')}`, { returns: 'many' }))
      .length,
    1,
  );
  await assert.rejects(
    leaked!.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')}`, { returns: 'many' }),
    /transaction has finished/,
  );
});

test('a caught PostgreSQL error cannot make an aborted transaction report success', async () => {
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(
        sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('duplicate')`,
        {
          returns: 'many',
        },
      );
      try {
        await tx.query(
          sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('duplicate')`,
          {
            returns: 'many',
          },
        );
      } catch {
        /* PostgreSQL has aborted the transaction. */
      }
      return 'must not be reported as committed';
    }),
    /rolled back the aborted transaction/,
  );
  assert.deepEqual(
    await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')}`, { returns: 'many' }),
    [],
  );
});

test('rejected transaction boundaries cannot commit writes early or abort a caught callback', async () => {
  const operations = {
    commit: defineOperation(() => sql`; /* ownership */ COMMIT AND CHAIN`),
    rollback: defineOperation(() => sql`ROLLBACK TRANSACTION`),
  };
  const client = createTenon({ connection: pool });
  try {
    for (const entry of ['sql', 'run'] as const) {
      await assert.rejects(
        client.transaction(async (tx) => {
          await tx.query(
            sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${entry})`,
          );
          if (entry === 'sql') await tx.query(sql`COMMIT`);
          else await tx.run(operations.commit, []);
        }),
        /cannot start or end a transaction/,
      );
    }
    assert.deepEqual(
      (await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')}`)).rows,
      [],
    );
    await client.transaction(async (tx) => {
      await tx.query(sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('kept')`);
      await assert.rejects(tx.query(sql`COMMIT`), /cannot start or end a transaction/);
      await assert.rejects(tx.run(operations.rollback, []), /cannot start or end a transaction/);
      await tx.query(
        sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('after rejection')`,
      );
    });
    const result = await db.query(
      sql<Pick<User, 'email'>>`SELECT email FROM ${identifier(namespace, 'User')} ORDER BY email`,
      { returns: 'many' },
    );
    assert.deepEqual(result, [{ email: 'after rejection' }, { email: 'kept' }]);
  } finally {
    await client.close();
  }
});

test('inline and named isolation and savepoint SQL preserve the callback transaction', async () => {
  const operations = {
    isolation: defineOperation(() => sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`),
    savepoint: defineOperation(() => sql`SAVEPOINT recovery`),
    rollback_to: defineOperation(
      () => sql`ROLLBACK /* comment */ TRANSACTION TO SAVEPOINT recovery`,
    ),
    release: defineOperation(() => sql`RELEASE SAVEPOINT recovery`),
  };
  const client = createTenon({ connection: pool });
  try {
    await client.transaction(async (tx) => {
      await tx.run(operations.isolation, []);
      const settings = await tx.query(
        sql<{ transaction_isolation: string }>`SHOW transaction_isolation`,
        { returns: 'one' },
      );
      assert.equal(settings.transaction_isolation, 'repeatable read');
      await tx.query(sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('kept')`);
      await tx.run(operations.savepoint, []);
      // Recover from a real PostgreSQL error without aborting the outer work.
      await assert.rejects(
        tx.query(sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('kept')`),
        {
          code: '23505',
        },
      );
      await tx.run(operations.rollback_to, []);
      await tx.run(operations.release, []);
      await tx.query(sql`SAVEPOINT "COMMIT"`);
      await tx.query(
        sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('discarded')`,
      );
      await tx.query(sql`ROLLBACK WORK TO SAVEPOINT "COMMIT"`);
      await tx.query(sql`RELEASE SAVEPOINT "COMMIT"`);
      await tx.query(
        sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('after recovery')`,
      );
    });
    const rows = await db.query(
      sql<Pick<User, 'email'>>`SELECT email FROM ${identifier(namespace, 'User')} ORDER BY email`,
      { returns: 'many' },
    );
    assert.deepEqual(rows, [{ email: 'after recovery' }, { email: 'kept' }]);
    // Inline isolation settings also work, and don't leak to the next transaction.
    await client.transaction(async (tx) => {
      await tx.query(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY`);
      const settings = await tx.query(
        sql<{ transaction_isolation: string }>`SHOW transaction_isolation`,
        { returns: 'one' },
      );
      assert.equal(settings.transaction_isolation, 'serializable');
    });
    await client.transaction(async (tx) => {
      await tx.query(
        sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('next transaction')`,
      );
    });
  } finally {
    await client.close();
  }
});

test('transaction words in values, identifiers and SQL bodies pass through unchanged', async () => {
  const operations = {
    echo: defineOperation(
      (value: string) => sql<{ COMMIT: string }>`SELECT ${value}::text AS "COMMIT"`,
    ),
    body: defineOperation(() => sql`DO $body$ BEGIN RAISE NOTICE 'COMMIT; ROLLBACK;'; END $body$`),
  };
  const client = createTenon({ connection: pool });
  try {
    await assert.rejects(
      client.transaction(async (tx) => {
        const inline = await tx.query(
          sql<{
            BEGIN: string;
            END: string;
          }>`/* COMMIT */ SELECT 'ROLLBACK; COMMIT;' AS "BEGIN", $body$BEGIN; END;$body$ AS "END"`,
        );
        assert.deepEqual(inline.rows, [{ BEGIN: 'ROLLBACK; COMMIT;', END: 'BEGIN; END;' }]);
        assert.deepEqual((await tx.run(operations.echo, ['PREPARE TRANSACTION'])).rows, [
          { COMMIT: 'PREPARE TRANSACTION' },
        ]);
        await tx.run(operations.body, []);
        await tx.query(sql`DO $body$ BEGIN RAISE NOTICE 'END;'; END $body$`);
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
          await tx.query(unsafeSql(prepared.sql, []));
          try {
            assert.deepEqual(
              (await tx.query(unsafeSql<{ value: number }>(prepared.execute, []))).rows,
              [{ value: prepared.value }],
            );
          } finally {
            await tx.query(sql`DEALLOCATE transaction`);
          }
        }
        await assert.rejects(tx.query(sql`SELECT FROM`), { code: '42601' });
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
    db.query(
      sql`INSERT INTO ${identifier(namespace, 'Post')} ("userId", title) VALUES (${99}, ${'orphan'})`,
      { returns: 'many' },
    ),
    { code: '23503', table: 'Post' },
  );
  const user = await db.query(
    sql<User>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('parent') RETURNING *`,
    { returns: 'one' },
  );
  await db.query(
    sql`INSERT INTO ${identifier(namespace, 'Post')} ("userId", title) VALUES (${user.id}, ${'child'})`,
    { returns: 'many' },
  );
  await db.query(sql`DELETE FROM ${identifier(namespace, 'User')} WHERE id = ${user.id}`, {
    returns: 'many',
  });
  assert.deepEqual(
    await db.query(sql`SELECT * FROM ${identifier(namespace, 'Post')}`, { returns: 'many' }),
    [],
  );
});

test('one inline call executes one statement, including calls with no parameters', async () => {
  await assert.rejects(
    db.query(
      sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('unexpected'); SELECT 1`,
      {
        returns: 'many',
      },
    ),
    /multiple commands/,
  );
  assert.deepEqual(
    await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')}`, { returns: 'many' }),
    [],
  );
  await assert.rejects(
    db.query(unsafeSql('SELECT $1::text', []), { returns: 'many' }),
    /bind message supplies 0 parameters/,
  );
  await assert.rejects(db.query(sql`SELECT missing_column`, { returns: 'many' }), {
    code: '42703',
  });
});

test('invalid queries and options reject before execution', async () => {
  const unchecked = db.query as (query: unknown, options?: unknown) => Promise<unknown>;
  for (const query of ['', 'SELECT 1', null, {}, { text: 'SELECT 1', values: [] }]) {
    await assert.rejects(unchecked(query), /Expected a query/);
  }
  for (const options of [null, [], { returns: 'first' }, { limit: 1 }]) {
    await assert.rejects(
      unchecked(sql`SELECT 1`, options),
      /plain object|Unknown operation option|Operation returns/,
    );
  }
});

test('close respects pool ownership and rejects subsequent SQL and transactions', async () => {
  const borrowed = createTenon({ connection: pool });
  await borrowed.close();
  await borrowed.close();
  await assert.rejects(borrowed.query(sql`SELECT 1`, { returns: 'many' }), /closed/);
  await assert.rejects(
    borrowed.transaction(async () => {}),
    /closed/,
  );
  assert.deepEqual(await db.query(sql<{ value: number }>`SELECT 1 AS value`, { returns: 'many' }), [
    { value: 1 },
  ]);
  const owned = createTenon({ connection });
  assert.deepEqual(
    await owned.query(sql<{ value: number }>`SELECT 2 AS value`, { returns: 'many' }),
    [{ value: 2 }],
  );
  await owned.close();
  await assert.rejects(owned.query(sql`SELECT 1`, { returns: 'many' }), /closed/);
});
