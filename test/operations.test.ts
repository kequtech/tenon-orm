import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import type { QueryResult, Transaction } from '../src/index.js';
import { createTenon, defineOperation, identifier, migrate, sql } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import type { Post, Tag, User } from './fixtures/generated-schema.js';
import { echo_values } from './fixtures/operations.js';

import { assertTestDatabase, testConnection as connection } from './helpers/database.js';
const namespace = `tenon_test_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({ connectionString: connection, max: 3 });
const target = qualified(namespace, 'User');
type UserSummary = Pick<User, 'id' | 'email'>;
type UserWithPosts = UserSummary & {
  posts: (Pick<Post, 'id' | 'title'> & { tags: Pick<Tag, 'id' | 'name'>[] })[];
};
const operations = {
  echo_values,
  users_by_email: defineOperation(
    (email: User['email'], active: User['active']) =>
      sql<UserSummary>`SELECT id, email FROM ${identifier(namespace, 'User')} WHERE email = ${email} AND active = ${active} ORDER BY id`,
    { returns: 'many' },
  ),
  create_user: defineOperation(
    (email: string) =>
      sql<UserSummary>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${email}) RETURNING id, email`,
    { returns: 'many' },
  ),
  user_by_email: defineOperation(
    (email: string) =>
      sql<UserSummary>`SELECT id, email FROM ${identifier(namespace, 'User')} WHERE email = ${email}`,
    { returns: 'oneOrNone' },
  ),
  required_user_by_email: defineOperation(
    (email: string) =>
      sql<UserSummary>`SELECT id, email FROM ${identifier(namespace, 'User')} WHERE email = ${email}`,
    { returns: 'one' },
  ),
  create_required_user: defineOperation(
    (email: string) =>
      sql<UserSummary>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${email}) RETURNING id, email`,
    { returns: 'one' },
  ),
  create_two: defineOperation(
    () =>
      sql<UserSummary>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('first'), ('second') RETURNING id, email`,
    { returns: 'one' },
  ),
  insert_user_command: defineOperation(
    (email: string) => sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${email})`,
    {
      returns: 'native',
    },
  ),
  update_users_command: defineOperation(
    (increment: number, active: boolean) =>
      sql`UPDATE ${identifier(namespace, 'User')} SET score = score + ${increment} WHERE active = ${active}`,
    { returns: 'native' },
  ),
  delete_users_command: defineOperation(
    (active: boolean) => sql`DELETE FROM ${identifier(namespace, 'User')} WHERE active = ${active}`,
    { returns: 'native' },
  ),
  insert_returning_command: defineOperation(
    (email: string) =>
      sql<UserSummary>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${email}) RETURNING id, email`,
  ),
  undeclared_rows: defineOperation(() => sql`SELECT 1 AS value`),
  create_table_command: defineOperation(
    () => sql`CREATE TABLE ${identifier(namespace, 'CommandScratch')} (id INTEGER)`,
    { returns: 'native' },
  ),
  drop_table_command: defineOperation(
    () => sql`DROP TABLE ${identifier(namespace, 'CommandScratch')}`,
    {
      returns: 'native',
    },
  ),
  user_with_posts: defineOperation(
    (id: User['id']) => sql<UserWithPosts>`
    SELECT u.id, u.email, COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'tags', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY t.id)
          FROM ${identifier(namespace, 'PostTag')} link
          JOIN ${identifier(namespace, 'Tag')} t ON t.id = link."tagId"
          WHERE link."postId" = p.id
        ), '[]'::jsonb)
      ) ORDER BY p.id)
      FROM ${identifier(namespace, 'Post')} p WHERE p."userId" = u.id
    ), '[]'::jsonb) AS posts
    FROM ${identifier(namespace, 'User')} u WHERE u.id = ${id}
  `,
    { returns: 'oneOrNone' },
  ),
  user_posts: defineOperation(
    () => sql<UserSummary & { title: string | null }>`
    SELECT u.id, u.email, p.title FROM ${identifier(namespace, 'User')} u
    LEFT JOIN ${identifier(namespace, 'Post')} p ON p."userId" = u.id
    ORDER BY u.id, p.id
  `,
    { returns: 'many' },
  ),
};
const db = createTenon({ connection: pool });
let ownsNamespace = false;

function assertNativeResult(
  result: QueryResult<Record<string, unknown>>,
  command: string,
  rowCount: number | null,
): void {
  assert.equal(result.command, command);
  assert.equal(result.rowCount, rowCount);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.fields, []);
  assert.notEqual(Object.getPrototypeOf(result), Object.prototype);
}

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
  await db.query(
    sql`TRUNCATE ${identifier(namespace, 'User')}, ${identifier(namespace, 'Tag')} RESTART IDENTITY CASCADE`,
    { returns: 'many' },
  );
});
after(async () => {
  try {
    if (ownsNamespace) await pool.query(`DROP SCHEMA IF EXISTS ${quote(namespace)} CASCADE`);
  } finally {
    await db.close();
    await pool.end();
  }
});

test('reusable operations bind explicit input arrays and coexist with inline SQL', async () => {
  const email = "alice'); DROP TABLE users; --";
  const [created] = await db.run(operations.create_user, [email]);
  assert.deepEqual(await db.run(operations.users_by_email, [email, false]), [
    { id: created!.id, email },
  ]);
  assert.deepEqual(await db.run(operations.users_by_email, [email, true]), []);
  assert.equal(
    (
      await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')} ORDER BY id`, {
        returns: 'many',
      })
    ).length,
    1,
  );
  await db.query(
    sql`UPDATE ${identifier(namespace, 'User')} SET active = ${true} WHERE id = ${created!.id}`,
    {
      returns: 'many',
    },
  );
  assert.deepEqual(await db.run(operations.users_by_email, [email, true]), [
    { id: created!.id, email },
  ]);
});

test('zero-parameter authored joins return complete row arrays with SQL nulls', async () => {
  await db.query(
    sql`INSERT INTO ${identifier(namespace, 'User')} (id, email) VALUES (1, 'a'), (2, 'b')`,
    {
      returns: 'many',
    },
  );
  const [a, b] = await db.query(
    sql<User>`SELECT * FROM ${identifier(namespace, 'User')} ORDER BY id`,
    { returns: 'many' },
  );
  await db.query(
    sql`INSERT INTO ${identifier(namespace, 'Post')} ("userId", title) VALUES (${a!.id}, 'one'), (${a!.id}, 'two')`,
    { returns: 'many' },
  );
  assert.deepEqual(await db.run(operations.user_posts, []), [
    { id: a!.id, email: 'a', title: 'one' },
    { id: a!.id, email: 'a', title: 'two' },
    { id: b!.id, email: 'b', title: null },
  ]);
});

test('reusable SQL operations own nested results and many-to-many joins without relation metadata', async () => {
  await db.query(
    sql`INSERT INTO ${identifier(namespace, 'User')} (id, email) VALUES (1, 'author'), (2, 'empty')`,
    {
      returns: 'many',
    },
  );
  const [author, empty] = await db.query(
    sql<User>`SELECT * FROM ${identifier(namespace, 'User')} ORDER BY id`,
    {
      returns: 'many',
    },
  );
  const [first, second] = await db.query(
    sql<Post>`INSERT INTO ${identifier(namespace, 'Post')} ("userId", title) VALUES (${author!.id}, 'first'), (${author!.id}, 'second') RETURNING *`,
    { returns: 'many' },
  );
  const tag = await db.query(
    sql<Tag>`INSERT INTO ${identifier(namespace, 'Tag')} (name) VALUES ('shared') RETURNING *`,
    { returns: 'one' },
  );
  await db.query(
    sql`INSERT INTO ${identifier(namespace, 'PostTag')} ("postId", "tagId") VALUES (${first!.id}, ${tag.id}), (${second!.id}, ${tag.id})`,
    { returns: 'many' },
  );
  assert.deepEqual(await db.run(operations.user_with_posts, [author!.id]), {
    id: author!.id,
    email: 'author',
    posts: [
      { id: first!.id, title: 'first', tags: [{ id: tag.id, name: 'shared' }] },
      { id: second!.id, title: 'second', tags: [{ id: tag.id, name: 'shared' }] },
    ],
  });
  assert.deepEqual(await db.run(operations.user_with_posts, [empty!.id]), {
    id: empty!.id,
    email: 'empty',
    posts: [],
  });
  assert.equal(await db.run(operations.user_with_posts, [-1]), undefined);
});

test('transaction clients retain single-row behavior and roll back writes when a cardinality error escapes', async () => {
  const result = await db.transaction(async (tx) => {
    assert.equal(await tx.run(operations.user_by_email, ['committed']), undefined);
    const created = await tx.run(operations.create_required_user, ['committed']);
    assert.deepEqual(await tx.run(operations.user_by_email, ['committed']), created);
    return tx.run(operations.required_user_by_email, ['committed']);
  });
  assert.equal(result.email, 'committed');

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.run(operations.create_required_user, ['rollback']);
      await tx.run(operations.required_user_by_email, ['missing']);
    }),
    /returned 0 rows/,
  );
  assert.equal(await db.run(operations.user_by_email, ['rollback']), undefined);

  await assert.rejects(
    db.transaction((tx) => tx.run(operations.create_two, [])),
    /returned 2 rows/,
  );
  assert.equal(await db.run(operations.user_by_email, ['first']), undefined);
  assert.equal(await db.run(operations.user_by_email, ['second']), undefined);
});

test('native mode reports inserted, updated and deleted rows, including zero matches', async () => {
  assertNativeResult(await db.run(operations.insert_user_command, ['alice']), 'INSERT', 1);
  assertNativeResult(await db.run(operations.insert_user_command, ['bob']), 'INSERT', 1);
  assertNativeResult(await db.run(operations.update_users_command, [3, false]), 'UPDATE', 2);
  assert.deepEqual(
    (
      await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')} ORDER BY id`, {
        returns: 'many',
      })
    ).map((user) => user.score),
    [3, 3],
  );
  assertNativeResult(await db.run(operations.delete_users_command, [true]), 'DELETE', 0);
  assertNativeResult(await db.run(operations.delete_users_command, [false]), 'DELETE', 2);
  assert.deepEqual(
    await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')} ORDER BY id`, {
      returns: 'many',
    }),
    [],
  );
});

test('native mode preserves native result metadata, explicit RETURNING rows and database errors', async () => {
  assert.deepEqual((await db.run(operations.undeclared_rows, [])).rows, [{ value: 1 }]);
  const result = await db.run(operations.insert_returning_command, ['alice']);
  assert.equal(result.command, 'INSERT');
  assert.equal(result.rowCount, 1);
  assert.deepEqual(result.rows, [{ id: 1, email: 'alice' }]);
  assert.deepEqual(
    result.fields.map((field) => field.name),
    ['id', 'email'],
  );
  assert.notEqual(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(
    (
      await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')} ORDER BY id`, {
        returns: 'many',
      })
    )[0]!.email,
    'alice',
  );
  await assert.rejects(db.run(operations.insert_user_command, ['alice']), { code: '23505' });
});

test('commands without a PostgreSQL count return null rather than zero', async () => {
  assertNativeResult(await db.run(operations.create_table_command, []), 'CREATE', null);
  assertNativeResult(await db.run(operations.drop_table_command, []), 'DROP', null);
});

test('command metadata follows the transaction connection and writes commit or roll back together', async () => {
  const committed = await db.transaction(async (tx) => {
    const result = await tx.run(operations.insert_user_command, ['committed']);
    assert.equal(
      (await tx.run(operations.required_user_by_email, ['committed'])).email,
      'committed',
    );
    return result;
  });
  assertNativeResult(committed, 'INSERT', 1);
  assert.ok(await db.run(operations.user_by_email, ['committed']));
  await assert.rejects(
    db.transaction(async (tx) => {
      assertNativeResult(await tx.run(operations.delete_users_command, [false]), 'DELETE', 1);
      assert.equal(await tx.run(operations.user_by_email, ['committed']), undefined);
      throw new Error('cancel command');
    }),
    /cancel command/,
  );
  assert.ok(await db.run(operations.user_by_email, ['committed']));
});

test('an imported operation works across clients and transactions', async () => {
  const client = createTenon({ connection: pool });
  try {
    assert.deepEqual(await client.run(echo_values, ['hello', false]), [
      { label: 'hello', enabled: false },
    ]);
    await client.transaction(async (tx) => {
      assert.deepEqual(await tx.run(echo_values, ['transaction', true]), [
        { label: 'transaction', enabled: true },
      ]);
    });
  } finally {
    await client.close();
  }
  await assert.rejects(client.run(echo_values, ['closed', false]), /closed/);
});

test('transaction operations share the inline SQL connection and commit or roll back together', async () => {
  await assert.rejects(
    db.transaction(async (tx) => {
      const [created] = await tx.run(operations.create_user, ['rollback']);
      assert.equal(
        (
          await tx.query(
            sql<User>`SELECT * FROM ${identifier(namespace, 'User')} WHERE id = ${created!.id}`,
            {
              returns: 'one',
            },
          )
        ).email,
        'rollback',
      );
      throw new Error('cancel work');
    }),
    /cancel work/,
  );
  assert.deepEqual(await db.run(operations.users_by_email, ['rollback', false]), []);
  let finished: Transaction | undefined;
  await db.transaction(async (tx) => {
    finished = tx;
    await tx.run(operations.create_user, ['committed']);
  });
  assert.equal((await db.run(operations.users_by_email, ['committed', false])).length, 1);
  await assert.rejects(finished!.run(echo_values, ['late', true]), /finished/);
});

test('JavaScript calls reject invalid definitions and require explicit input arrays', async () => {
  const unchecked = db as unknown as { run(operation: unknown, input?: unknown): Promise<unknown> };
  await assert.rejects(unchecked.run('missing', []), /requires an operation/);
  await assert.rejects(unchecked.run('toString', []), /requires an operation/);
  await assert.rejects(unchecked.run('__proto__', []), /requires an operation/);
  for (const invalid of [null, {}, { sql: 'SELECT 1' }]) {
    await assert.rejects(unchecked.run(invalid, []), /requires an operation/);
  }
  await assert.rejects(unchecked.run(echo_values), /explicit array/);
  await assert.rejects(
    unchecked.run(echo_values, { label: 'hello', enabled: true }),
    /explicit array/,
  );
  // Factory arity is checked statically; pg binds a JavaScript undefined as null.
  assert.deepEqual(await unchecked.run(echo_values, ['hello']), [
    { label: 'hello', enabled: null },
  ]);
});

test('definitions are immutable and reusable across clients, and database errors propagate', async () => {
  const broken = defineOperation(() => sql`SELECT missing_column`, { returns: 'many' });
  const client = createTenon({ connection: pool });
  try {
    assert.throws(() => Object.assign(echo_values, { sql: 'SELECT 2' }), TypeError);
    assert.deepEqual(await client.run(echo_values, ['original', true]), [
      { label: 'original', enabled: true },
    ]);
    assert.deepEqual(await db.run(echo_values, ['shared', false]), [
      { label: 'shared', enabled: false },
    ]);
    await assert.rejects(client.run(broken, []), { code: '42703' });
  } finally {
    await client.close();
  }
});

test('one operation executes one statement even with an empty input tuple', async () => {
  const operations = {
    multiple: defineOperation(
      () =>
        sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('unexpected'); SELECT 1`,
      {
        returns: 'many',
      },
    ),
    multiple_command: defineOperation(
      () =>
        sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('unexpected'); SELECT 1`,
      { returns: 'native' },
    ),
  };
  const client = createTenon({ connection: pool });
  try {
    await assert.rejects(client.run(operations.multiple, []), /multiple commands/);
    await assert.rejects(client.run(operations.multiple_command, []), /multiple commands/);
    assert.deepEqual(
      await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')} ORDER BY id`, {
        returns: 'many',
      }),
      [],
    );
  } finally {
    await client.close();
  }
});

test('operation definitions validate SQL and options before connecting', () => {
  assert.throws(() => sql`  `, /nonempty string/);
  assert.ok(Object.isFrozen(echo_values));
  const unchecked = defineOperation as (
    build: () => ReturnType<typeof sql>,
    options?: unknown,
  ) => unknown;
  for (const options of [
    null,
    [],
    'one',
    { returns: 'first' },
    { returns: 'command' },
    { returns: null },
    { returns: false },
    { return: 'one' },
  ]) {
    assert.throws(
      () => unchecked(() => sql`SELECT 1`, options),
      /plain object|Unknown operation option|Operation returns/,
    );
  }
  assert.equal(operations.insert_returning_command.options.returns, 'native');
  assert.equal(echo_values.options.returns, 'many');
  assert.equal(operations.user_by_email.options.returns, 'oneOrNone');
  assert.equal(operations.required_user_by_email.options.returns, 'one');
});
