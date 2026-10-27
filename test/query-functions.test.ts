import type { QueryClient } from '../src/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import postgres from 'postgres';
import type { QueryResult, Transaction } from '../src/index.js';
import { createTenon, identifier, migrate, sql } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import type { Post, Tag, User } from './fixtures/generated-schema.js';
import { echoValues } from './fixtures/queries.js';

import { assertTestDatabase, testConnection as connection } from './helpers/database.js';
const namespace = `tenon_test_${randomUUID().replaceAll('-', '')}`;
const pool = postgres(connection, { max: 3 });
const target = qualified(namespace, 'User');
type UserSummary = Pick<User, 'id' | 'email'>;
type UserWithPosts = UserSummary & {
  posts: (Pick<Post, 'id' | 'title'> & { tags: Pick<Tag, 'id' | 'name'>[] })[];
};
const queries = {
  echoValues,
  users_by_email: (
    client: QueryClient,
    { email, active }: { email: User['email']; active: User['active'] },
  ) =>
    client.query(
      sql<UserSummary>`SELECT id, email FROM ${identifier(namespace, 'User')} WHERE email = ${email} AND active = ${active} ORDER BY id`,
      { returns: 'many' },
    ),
  create_user: (client: QueryClient, { email }: { email: string }) =>
    client.query(
      sql<UserSummary>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${email}) RETURNING id, email`,
      { returns: 'many' },
    ),
  user_by_email: (client: QueryClient, { email }: { email: string }) =>
    client.query(
      sql<UserSummary>`SELECT id, email FROM ${identifier(namespace, 'User')} WHERE email = ${email}`,
      { returns: 'oneOrNone' },
    ),
  required_user_by_email: (client: QueryClient, { email }: { email: string }) =>
    client.query(
      sql<UserSummary>`SELECT id, email FROM ${identifier(namespace, 'User')} WHERE email = ${email}`,
      { returns: 'one' },
    ),
  create_required_user: (client: QueryClient, { email }: { email: string }) =>
    client.query(
      sql<UserSummary>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${email}) RETURNING id, email`,
      { returns: 'one' },
    ),
  create_two: (client: QueryClient) =>
    client.query(
      sql<UserSummary>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('first'), ('second') RETURNING id, email`,
      { returns: 'one' },
    ),
  insert_user_command: (client: QueryClient, { email }: { email: string }) =>
    client.query(sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${email})`, {
      returns: 'native',
    }),
  update_users_command: (
    client: QueryClient,
    { increment, active }: { increment: number; active: boolean },
  ) =>
    client.query(
      sql`UPDATE ${identifier(namespace, 'User')} SET score = score + ${increment} WHERE active = ${active}`,
      { returns: 'native' },
    ),
  delete_users_command: (client: QueryClient, { active }: { active: boolean }) =>
    client.query(sql`DELETE FROM ${identifier(namespace, 'User')} WHERE active = ${active}`, {
      returns: 'native',
    }),
  insert_returning_command: (client: QueryClient, { email }: { email: string }) =>
    client.query(
      sql<UserSummary>`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES (${email}) RETURNING id, email`,
    ),
  undeclared_rows: (client: QueryClient) => client.query(sql`SELECT 1 AS value`),
  create_table_command: (client: QueryClient) =>
    client.query(sql`CREATE TABLE ${identifier(namespace, 'CommandScratch')} (id INTEGER)`, {
      returns: 'native',
    }),
  drop_table_command: (client: QueryClient) =>
    client.query(sql`DROP TABLE ${identifier(namespace, 'CommandScratch')}`, {
      returns: 'native',
    }),
  user_with_posts: (client: QueryClient, { id }: { id: User['id'] }) =>
    client.query(
      sql<UserWithPosts>`
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
  user_posts: (client: QueryClient) =>
    client.query(
      sql<UserSummary & { title: string | null }>`
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
  assert.equal(result.count, rowCount);
  assert.deepEqual([...result], []);
  assert.deepEqual(result.columns, []);
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
    if (ownsNamespace) await pool.unsafe(`DROP SCHEMA IF EXISTS ${quote(namespace)} CASCADE`);
  } finally {
    await db.close();
    await pool.end();
  }
});

test('query functions bind named inputs and coexist with inline SQL', async () => {
  const email = "alice'); DROP TABLE users; --";
  const [created] = await queries.create_user(db, { email });
  assert.deepEqual(await queries.users_by_email(db, { email, active: false }), [
    { id: created!.id, email },
  ]);
  assert.deepEqual(await queries.users_by_email(db, { email, active: true }), []);
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
  assert.deepEqual(await queries.users_by_email(db, { email, active: true }), [
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
  assert.deepEqual(await queries.user_posts(db), [
    { id: a!.id, email: 'a', title: 'one' },
    { id: a!.id, email: 'a', title: 'two' },
    { id: b!.id, email: 'b', title: null },
  ]);
});

test('query functions own nested results and many-to-many joins without relation metadata', async () => {
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
  assert.deepEqual(await queries.user_with_posts(db, { id: author!.id }), {
    id: author!.id,
    email: 'author',
    posts: [
      { id: first!.id, title: 'first', tags: [{ id: tag.id, name: 'shared' }] },
      { id: second!.id, title: 'second', tags: [{ id: tag.id, name: 'shared' }] },
    ],
  });
  assert.deepEqual(await queries.user_with_posts(db, { id: empty!.id }), {
    id: empty!.id,
    email: 'empty',
    posts: [],
  });
  assert.equal(await queries.user_with_posts(db, { id: -1 }), undefined);
});

test('transaction clients retain single-row behavior and roll back writes when a cardinality error escapes', async () => {
  const result = await db.transaction(async (tx) => {
    assert.equal(await queries.user_by_email(tx, { email: 'committed' }), undefined);
    const created = await queries.create_required_user(tx, { email: 'committed' });
    assert.deepEqual(await queries.user_by_email(tx, { email: 'committed' }), created);
    return queries.required_user_by_email(tx, { email: 'committed' });
  });
  assert.equal(result.email, 'committed');

  await assert.rejects(
    db.transaction(async (tx) => {
      await queries.create_required_user(tx, { email: 'rollback' });
      await queries.required_user_by_email(tx, { email: 'missing' });
    }),
    /returned 0 rows/,
  );
  assert.equal(await queries.user_by_email(db, { email: 'rollback' }), undefined);

  await assert.rejects(
    db.transaction((tx) => queries.create_two(tx)),
    /returned 2 rows/,
  );
  assert.equal(await queries.user_by_email(db, { email: 'first' }), undefined);
  assert.equal(await queries.user_by_email(db, { email: 'second' }), undefined);
});

test('native mode reports inserted, updated and deleted rows, including zero matches', async () => {
  assertNativeResult(await queries.insert_user_command(db, { email: 'alice' }), 'INSERT', 1);
  assertNativeResult(await queries.insert_user_command(db, { email: 'bob' }), 'INSERT', 1);
  assertNativeResult(
    await queries.update_users_command(db, { increment: 3, active: false }),
    'UPDATE',
    2,
  );
  assert.deepEqual(
    (
      await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')} ORDER BY id`, {
        returns: 'many',
      })
    ).map((user) => user.score),
    [3, 3],
  );
  assertNativeResult(await queries.delete_users_command(db, { active: true }), 'DELETE', 0);
  assertNativeResult(await queries.delete_users_command(db, { active: false }), 'DELETE', 2);
  assert.deepEqual(
    await db.query(sql<User>`SELECT * FROM ${identifier(namespace, 'User')} ORDER BY id`, {
      returns: 'many',
    }),
    [],
  );
});

test('native mode preserves native result metadata, explicit RETURNING rows and database errors', async () => {
  assert.deepEqual([...(await queries.undeclared_rows(db))], [{ value: 1 }]);
  const result = await queries.insert_returning_command(db, { email: 'alice' });
  assert.equal(result.command, 'INSERT');
  assert.equal(result.count, 1);
  assert.deepEqual([...result], [{ id: 1, email: 'alice' }]);
  assert.deepEqual(
    result.columns.map((field) => field.name),
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
  await assert.rejects(queries.insert_user_command(db, { email: 'alice' }), { code: '23505' });
});

test('commands without a PostgreSQL count return null rather than zero', async () => {
  assertNativeResult(await queries.create_table_command(db), 'CREATE TABLE', null);
  assertNativeResult(await queries.drop_table_command(db), 'DROP TABLE', null);
});

test('command metadata follows the transaction connection and writes commit or roll back together', async () => {
  const committed = await db.transaction(async (tx) => {
    const result = await queries.insert_user_command(tx, { email: 'committed' });
    assert.equal(
      (await queries.required_user_by_email(tx, { email: 'committed' })).email,
      'committed',
    );
    return result;
  });
  assertNativeResult(committed, 'INSERT', 1);
  assert.ok(await queries.user_by_email(db, { email: 'committed' }));
  await assert.rejects(
    db.transaction(async (tx) => {
      assertNativeResult(await queries.delete_users_command(tx, { active: false }), 'DELETE', 1);
      assert.equal(await queries.user_by_email(tx, { email: 'committed' }), undefined);
      throw new Error('cancel command');
    }),
    /cancel command/,
  );
  assert.ok(await queries.user_by_email(db, { email: 'committed' }));
});

test('an imported query function works across clients and transactions', async () => {
  const client = createTenon({ connection: pool });
  try {
    assert.deepEqual(await echoValues(client, { label: 'hello', enabled: false }), [
      { label: 'hello', enabled: false },
    ]);
    await client.transaction(async (tx) => {
      assert.deepEqual(await echoValues(tx, { label: 'transaction', enabled: true }), [
        { label: 'transaction', enabled: true },
      ]);
    });
  } finally {
    await client.close();
  }
  await assert.rejects(echoValues(client, { label: 'closed', enabled: false }), /closed/);
});

test('query functions share the inline SQL connection and commit or roll back together', async () => {
  await assert.rejects(
    db.transaction(async (tx) => {
      const [created] = await queries.create_user(tx, { email: 'rollback' });
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
  assert.deepEqual(await queries.users_by_email(db, { email: 'rollback', active: false }), []);
  let finished: Transaction | undefined;
  await db.transaction(async (tx) => {
    finished = tx;
    await queries.create_user(tx, { email: 'committed' });
  });
  assert.equal((await queries.users_by_email(db, { email: 'committed', active: false })).length, 1);
  await assert.rejects(echoValues(finished!, { label: 'late', enabled: true }), /finished/);
});

test('query functions bind array inputs and preserve object defaults', async () => {
  const echo = (
    client: QueryClient,
    {
      ids,
      details,
      enabled = true,
    }: { ids: readonly number[]; details: { label: string }; enabled?: boolean },
  ) =>
    client.query(
      sql<{ ids: number[]; label: string; enabled: boolean }>`
        SELECT ${ids}::int[] AS ids, ${details.label}::text AS label, ${enabled}::boolean AS enabled
      `,
      { returns: 'one' },
    );
  assert.deepEqual(await echo(db, { ids: [1, 2], details: { label: 'default' } }), {
    ids: [1, 2],
    label: 'default',
    enabled: true,
  });
  await db.transaction(async (tx) => {
    assert.deepEqual(await echo(tx, { ids: [3], details: { label: 'explicit' }, enabled: false }), {
      ids: [3],
      label: 'explicit',
      enabled: false,
    });
  });
});

test('query functions work across clients and preserve database errors', async () => {
  const broken = (client: QueryClient) =>
    client.query(sql`SELECT missing_column`, { returns: 'many' });
  const client = createTenon({ connection: pool });
  try {
    assert.deepEqual(await echoValues(client, { label: 'original', enabled: true }), [
      { label: 'original', enabled: true },
    ]);
    assert.deepEqual(await echoValues(db, { label: 'shared', enabled: false }), [
      { label: 'shared', enabled: false },
    ]);
    await assert.rejects(broken(client), { code: '42703' });
  } finally {
    await client.close();
  }
});

test('a query function executes one statement even without inputs', async () => {
  const queries = {
    multiple: (client: QueryClient) =>
      client.query(
        sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('unexpected'); SELECT 1`,
        {
          returns: 'many',
        },
      ),
    multiple_command: (client: QueryClient) =>
      client.query(
        sql`INSERT INTO ${identifier(namespace, 'User')} (email) VALUES ('unexpected'); SELECT 1`,
        { returns: 'native' },
      ),
  };
  const client = createTenon({ connection: pool });
  try {
    await assert.rejects(queries.multiple(client), /multiple commands/);
    await assert.rejects(queries.multiple_command(client), /multiple commands/);
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
