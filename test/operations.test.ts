import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import type { OperationRegistry, QueryResult, Transaction } from '../src/index.js';
import { createTenon, define, migrate, TenonError } from '../src/index.js';
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
  users_by_email: define<UserSummary, [email: User['email'], active: User['active']]>(
    `SELECT id, email FROM ${target} WHERE email = $1 AND active = $2 ORDER BY id`,
    { returns: 'many' },
  ),
  create_user: define<UserSummary, [email: string]>(
    `INSERT INTO ${target} (email) VALUES ($1) RETURNING id, email`,
    { returns: 'many' },
  ),
  user_by_email: define<UserSummary, [email: string]>(
    `SELECT id, email FROM ${target} WHERE email = $1`,
    { returns: 'one' },
  ),
  required_user_by_email: define<UserSummary, [email: string]>(
    `SELECT id, email FROM ${target} WHERE email = $1`,
    { returns: 'requiredOne' },
  ),
  one_active_user: define<UserSummary, []>(`SELECT id, email FROM ${target} WHERE active`, {
    returns: 'one',
  }),
  required_active_user: define<UserSummary, []>(`SELECT id, email FROM ${target} WHERE active`, {
    returns: 'requiredOne',
  }),
  first_active_user: define<UserSummary, []>(
    `SELECT id, email FROM ${target} WHERE active ORDER BY id LIMIT 1`,
    { returns: 'one' },
  ),
  active_users: define<UserSummary, []>(
    `SELECT id, email FROM ${target} WHERE active ORDER BY id`,
    { returns: 'many' },
  ),
  nullable_user: define<{ nickname: string | null }, [email: string]>(
    `SELECT nickname FROM ${target} WHERE email = $1`,
    { returns: 'one' },
  ),
  create_required_user: define<UserSummary, [email: string]>(
    `INSERT INTO ${target} (email) VALUES ($1) RETURNING id, email`,
    { returns: 'requiredOne' },
  ),
  create_two: define<UserSummary, []>(
    `INSERT INTO ${target} (email) VALUES ('first'), ('second') RETURNING id, email`,
    { returns: 'requiredOne' },
  ),
  insert_user_command: define<never, [email: string]>(`INSERT INTO ${target} (email) VALUES ($1)`, {
    returns: 'native',
  }),
  update_users_command: define<never, [increment: number, active: boolean]>(
    `UPDATE ${target} SET score = score + $1 WHERE active = $2`,
    { returns: 'native' },
  ),
  delete_users_command: define<never, [active: boolean]>(
    `DELETE FROM ${target} WHERE active = $1`,
    { returns: 'native' },
  ),
  insert_returning_command: define<UserSummary, [email: string]>(
    `INSERT INTO ${target} (email) VALUES ($1) RETURNING id, email`,
  ),
  undeclared_rows: define('SELECT 1 AS value'),
  create_table_command: define(
    `CREATE TABLE ${qualified(namespace, 'CommandScratch')} (id INTEGER)`,
    { returns: 'native' },
  ),
  drop_table_command: define(`DROP TABLE ${qualified(namespace, 'CommandScratch')}`, {
    returns: 'native',
  }),
  user_with_posts: define<UserWithPosts, [id: User['id']]>(
    `
    SELECT u.id, u.email, COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'tags', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY t.id)
          FROM ${qualified(namespace, 'PostTag')} link
          JOIN ${qualified(namespace, 'Tag')} t ON t.id = link."tagId"
          WHERE link."postId" = p.id
        ), '[]'::jsonb)
      ) ORDER BY p.id)
      FROM ${qualified(namespace, 'Post')} p WHERE p."userId" = u.id
    ), '[]'::jsonb) AS posts
    FROM ${target} u WHERE u.id = $1
  `,
    { returns: 'one' },
  ),
  user_posts: define<UserSummary & { title: string | null }, []>(
    `
    SELECT u.id, u.email, p.title FROM ${target} u
    LEFT JOIN ${qualified(namespace, 'Post')} p ON p."userId" = u.id
    ORDER BY u.id, p.id
  `,
    { returns: 'many' },
  ),
} satisfies OperationRegistry;
const db = createTenon({ connection: pool, operations });
let ownsNamespace = false;

function assertNativeResult(
  result: QueryResult<never>,
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
  await db.sql<object>(
    `TRUNCATE ${target}, ${qualified(namespace, 'Tag')} RESTART IDENTITY CASCADE`,
    [],
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

test('named operations bind explicit input arrays and coexist with inline SQL', async () => {
  const email = "alice'); DROP TABLE users; --";
  const [created] = await db.run('create_user', [email]);
  assert.deepEqual(await db.run('users_by_email', [email, false]), [{ id: created!.id, email }]);
  assert.deepEqual(await db.run('users_by_email', [email, true]), []);
  assert.equal(
    (await db.sql<User>(`SELECT * FROM ${target} ORDER BY id`, [], { returns: 'many' })).length,
    1,
  );
  await db.sql<object>(`UPDATE ${target} SET active = $1 WHERE id = $2`, [true, created!.id], {
    returns: 'many',
  });
  assert.deepEqual(await db.run('users_by_email', [email, true]), [{ id: created!.id, email }]);
});

test('zero-parameter authored joins return complete row arrays with SQL nulls', async () => {
  await db.sql<object>(`INSERT INTO ${target} (id, email) VALUES (1, 'a'), (2, 'b')`, [], {
    returns: 'many',
  });
  const [a, b] = await db.sql<User>(`SELECT * FROM ${target} ORDER BY id`, [], { returns: 'many' });
  await db.sql<object>(
    `INSERT INTO ${qualified(namespace, 'Post')} ("userId", title) VALUES ($1, 'one'), ($1, 'two')`,
    [a!.id],
    { returns: 'many' },
  );
  assert.deepEqual(await db.run('user_posts', []), [
    { id: a!.id, email: 'a', title: 'one' },
    { id: a!.id, email: 'a', title: 'two' },
    { id: b!.id, email: 'b', title: null },
  ]);
});

test('named SQL operations own nested results and many-to-many joins without relation metadata', async () => {
  await db.sql<object>(`INSERT INTO ${target} (id, email) VALUES (1, 'author'), (2, 'empty')`, [], {
    returns: 'many',
  });
  const [author, empty] = await db.sql<User>(`SELECT * FROM ${target} ORDER BY id`, [], {
    returns: 'many',
  });
  const [first, second] = await db.sql<Post>(
    `INSERT INTO ${qualified(namespace, 'Post')} ("userId", title) VALUES ($1, 'first'), ($1, 'second') RETURNING *`,
    [author!.id],
    { returns: 'many' },
  );
  const tag = await db.sql<Tag>(
    `INSERT INTO ${qualified(namespace, 'Tag')} (name) VALUES ('shared') RETURNING *`,
    [],
    { returns: 'requiredOne' },
  );
  await db.sql<object>(
    `INSERT INTO ${qualified(namespace, 'PostTag')} ("postId", "tagId") VALUES ($1, $3), ($2, $3)`,
    [first!.id, second!.id, tag.id],
    { returns: 'many' },
  );
  assert.deepEqual(await db.run('user_with_posts', [author!.id]), {
    id: author!.id,
    email: 'author',
    posts: [
      { id: first!.id, title: 'first', tags: [{ id: tag.id, name: 'shared' }] },
      { id: second!.id, title: 'second', tags: [{ id: tag.id, name: 'shared' }] },
    ],
  });
  assert.deepEqual(await db.run('user_with_posts', [empty!.id]), {
    id: empty!.id,
    email: 'empty',
    posts: [],
  });
  assert.equal(await db.run('user_with_posts', [-1]), undefined);
});

test('one returns undefined for absence and a row object for a match, preserving nullable values', async () => {
  assert.equal(await db.run('user_by_email', ['alice']), undefined);
  assert.equal(await db.run('nullable_user', ['alice']), undefined);
  const user = await db.run('create_required_user', ['alice']);
  assert.deepEqual(await db.run('user_by_email', ['alice']), { id: user.id, email: 'alice' });
  assert.deepEqual(await db.run('nullable_user', ['alice']), { nickname: null });
});

test('requiredOne returns one row and reports an absent row with its operation name', async () => {
  await assert.rejects(db.run('required_user_by_email', ['alice']), (error) => {
    assert.ok(error instanceof TenonError);
    assert.equal(
      error.message,
      'Operation required_user_by_email expected exactly one row, but returned 0 rows.',
    );
    return true;
  });
  const user = await db.run('create_required_user', ['alice']);
  assert.equal(user.email, 'alice');
  assert.deepEqual(await db.run('required_user_by_email', ['alice']), user);
});

test('single-row modes reject multiple matches while many and an explicit SQL limit preserve their contracts', async () => {
  assert.deepEqual(await db.run('active_users', []), []);
  await db.sql<object>(
    `INSERT INTO ${target} (email, active) VALUES ('a', true), ('b', true), ('c', true)`,
    [],
    { returns: 'many' },
  );
  const users = await db.sql<User>(`SELECT * FROM ${target} ORDER BY id`, [], { returns: 'many' });
  const summaries = users.map(({ id, email }) => ({ id, email }));
  assert.deepEqual(await db.run('active_users', []), summaries);
  await assert.rejects(
    db.run('one_active_user', []),
    /Operation one_active_user expected at most one row, but returned 3 rows/,
  );
  await assert.rejects(
    db.run('required_active_user', []),
    /Operation required_active_user expected exactly one row, but returned 3 rows/,
  );
  assert.deepEqual(await db.run('first_active_user', []), summaries[0]);
});

test('transaction clients retain single-row behavior and roll back writes when a cardinality error escapes', async () => {
  const result = await db.transaction(async (tx) => {
    assert.equal(await tx.run('user_by_email', ['committed']), undefined);
    const created = await tx.run('create_required_user', ['committed']);
    assert.deepEqual(await tx.run('user_by_email', ['committed']), created);
    return tx.run('required_user_by_email', ['committed']);
  });
  assert.equal(result.email, 'committed');

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.run('create_required_user', ['rollback']);
      await tx.run('required_user_by_email', ['missing']);
    }),
    /returned 0 rows/,
  );
  assert.equal(await db.run('user_by_email', ['rollback']), undefined);

  await assert.rejects(
    db.transaction((tx) => tx.run('create_two', [])),
    /returned 2 rows/,
  );
  assert.equal(await db.run('user_by_email', ['first']), undefined);
  assert.equal(await db.run('user_by_email', ['second']), undefined);
});

test('native mode reports inserted, updated and deleted rows, including zero matches', async () => {
  assertNativeResult(await db.run('insert_user_command', ['alice']), 'INSERT', 1);
  assertNativeResult(await db.run('insert_user_command', ['bob']), 'INSERT', 1);
  assertNativeResult(await db.run('update_users_command', [3, false]), 'UPDATE', 2);
  assert.deepEqual(
    (await db.sql<User>(`SELECT * FROM ${target} ORDER BY id`, [], { returns: 'many' })).map(
      (user) => user.score,
    ),
    [3, 3],
  );
  assertNativeResult(await db.run('delete_users_command', [true]), 'DELETE', 0);
  assertNativeResult(await db.run('delete_users_command', [false]), 'DELETE', 2);
  assert.deepEqual(
    await db.sql<User>(`SELECT * FROM ${target} ORDER BY id`, [], { returns: 'many' }),
    [],
  );
});

test('native mode preserves native result metadata, explicit RETURNING rows and database errors', async () => {
  assert.deepEqual((await db.run('undeclared_rows', [])).rows, [{ value: 1 }]);
  const result = await db.run('insert_returning_command', ['alice']);
  assert.equal(result.command, 'INSERT');
  assert.equal(result.rowCount, 1);
  assert.deepEqual(result.rows, [{ id: 1, email: 'alice' }]);
  assert.deepEqual(
    result.fields.map((field) => field.name),
    ['id', 'email'],
  );
  assert.notEqual(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(
    (await db.sql<User>(`SELECT * FROM ${target} ORDER BY id`, [], { returns: 'many' }))[0]!.email,
    'alice',
  );
  await assert.rejects(db.run('insert_user_command', ['alice']), { code: '23505' });
});

test('commands without a PostgreSQL count return null rather than zero', async () => {
  assertNativeResult(await db.run('create_table_command', []), 'CREATE', null);
  assertNativeResult(await db.run('drop_table_command', []), 'DROP', null);
});

test('command metadata follows the transaction connection and writes commit or roll back together', async () => {
  const committed = await db.transaction(async (tx) => {
    const result = await tx.run('insert_user_command', ['committed']);
    assert.equal((await tx.run('required_user_by_email', ['committed'])).email, 'committed');
    return result;
  });
  assertNativeResult(committed, 'INSERT', 1);
  assert.ok(await db.run('user_by_email', ['committed']));
  await assert.rejects(
    db.transaction(async (tx) => {
      assertNativeResult(await tx.run('delete_users_command', [false]), 'DELETE', 1);
      assert.equal(await tx.run('user_by_email', ['committed']), undefined);
      throw new Error('cancel command');
    }),
    /cancel command/,
  );
  assert.ok(await db.run('user_by_email', ['committed']));
});

test('an imported operation works without runtime schema registration', async () => {
  const client = createTenon({ connection: pool, operations: { echo_values } });
  try {
    assert.deepEqual(await client.run('echo_values', ['hello', false]), [
      { label: 'hello', enabled: false },
    ]);
    await client.transaction(async (tx) => {
      assert.deepEqual(await tx.run('echo_values', ['transaction', true]), [
        { label: 'transaction', enabled: true },
      ]);
    });
  } finally {
    await client.close();
  }
  await assert.rejects(client.run('echo_values', ['closed', false]), /closed/);
});

test('transaction operations share the inline SQL connection and commit or roll back together', async () => {
  await assert.rejects(
    db.transaction(async (tx) => {
      const [created] = await tx.run('create_user', ['rollback']);
      assert.equal(
        (
          await tx.sql<User>(`SELECT * FROM ${target} WHERE id = $1`, [created!.id], {
            returns: 'requiredOne',
          })
        ).email,
        'rollback',
      );
      throw new Error('cancel work');
    }),
    /cancel work/,
  );
  assert.deepEqual(await db.run('users_by_email', ['rollback', false]), []);
  let finished: Transaction<typeof operations> | undefined;
  await db.transaction(async (tx) => {
    finished = tx;
    await tx.run('create_user', ['committed']);
  });
  assert.equal((await db.run('users_by_email', ['committed', false])).length, 1);
  await assert.rejects(finished!.run('echo_values', ['late', true]), /finished/);
});

test('JavaScript calls reject unknown names and require explicit input arrays', async () => {
  const unchecked = db as unknown as { run(name: string, input?: unknown): Promise<unknown> };
  await assert.rejects(unchecked.run('missing', []), /Unknown operation/);
  await assert.rejects(unchecked.run('toString', []), /Unknown operation/);
  await assert.rejects(unchecked.run('__proto__', []), /Unknown operation/);
  await assert.rejects(unchecked.run('echo_values'), /explicit array/);
  await assert.rejects(
    unchecked.run('echo_values', { label: 'hello', enabled: true }),
    /explicit array/,
  );
  // Parameter count is also checked by PostgreSQL when TypeScript is bypassed.
  await assert.rejects(
    unchecked.run('echo_values', ['hello']),
    /bind message supplies 1 parameters/,
  );
});

test('registrations are captured at construction and database errors propagate', async () => {
  const definitions = {
    echo: echo_values,
    broken: define<object, []>('SELECT missing_column', { returns: 'many' }),
  };
  const client = createTenon({ connection: pool, operations: definitions });
  definitions.echo = define<{ label: string; enabled: boolean }, [string, boolean]>(
    'SELECT $1::text AS label, NOT $2::boolean AS enabled',
    { returns: 'many' },
  );
  try {
    assert.deepEqual(await client.run('echo', ['original', true]), [
      { label: 'original', enabled: true },
    ]);
    await assert.rejects(client.run('broken', []), { code: '42703' });
  } finally {
    await client.close();
  }
});

test('one operation executes one statement even with an empty input tuple', async () => {
  const client = createTenon({
    connection: pool,
    operations: {
      multiple: define<object, []>(
        `INSERT INTO ${target} (email) VALUES ('unexpected'); SELECT 1`,
        { returns: 'many' },
      ),
      multiple_command: define<never, []>(
        `INSERT INTO ${target} (email) VALUES ('unexpected'); SELECT 1`,
        { returns: 'native' },
      ),
    },
  });
  try {
    await assert.rejects(client.run('multiple', []), /multiple commands/);
    await assert.rejects(client.run('multiple_command', []), /multiple commands/);
    assert.deepEqual(
      await db.sql<User>(`SELECT * FROM ${target} ORDER BY id`, [], { returns: 'many' }),
      [],
    );
  } finally {
    await client.close();
  }
});

test('operation definitions validate SQL and registry values before connecting', () => {
  assert.throws(() => define<object, []>('  ', { returns: 'many' }), /nonempty string/);
  assert.ok(Object.isFrozen(echo_values));
  for (const operations of [{ '': echo_values }, { invalid: { sql: 'SELECT 1' } }, []]) {
    assert.throws(
      () =>
        createTenon({ connection: pool, operations: operations as unknown as OperationRegistry }),
      /Operation names|define\(\)|plain object/,
    );
  }
  const unchecked = define as (sql: string, options?: unknown) => unknown;
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
      () => unchecked('SELECT 1', options),
      /plain object|Unknown operation option|Operation returns/,
    );
  }
  assert.equal(operations.insert_returning_command.returns, 'native');
  assert.equal(echo_values.returns, 'many');
  assert.equal(operations.user_by_email.returns, 'one');
  assert.equal(operations.required_user_by_email.returns, 'requiredOne');
});
