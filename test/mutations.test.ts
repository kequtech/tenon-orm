import assert from 'node:assert/strict';
import { test } from 'node:test';
import postgres from 'postgres';
import { createTenon, identifier, migrate, sql, unsafeSql } from '../src/index.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

test('insert fragments align heterogeneous rows, preserve defaults and null, and bind data', () => {
  const data = "name'); DROP TABLE users; --";
  const insert = sql.insertValues([
    { name: data, score: undefined },
    { score: 5, name: null },
  ]);
  const query = sql`INSERT INTO users ${insert} RETURNING id`;
  assert.equal(
    query.text,
    'INSERT INTO users ("name", "score") VALUES ($1, DEFAULT), ($2, $3) RETURNING id',
  );
  assert.deepEqual(query.values, [data, null, 5]);
  const selected = sql`INSERT INTO users ${sql.insertValues({ name: data, score: 2, ignored: true }, ['score', 'name'])}`;
  assert.equal(selected.text, 'INSERT INTO users ("score", "name") VALUES ($1, $2)');
  assert.deepEqual(selected.values, [2, data]);
  const defaults = sql`INSERT INTO users ${sql.insertValues({ name: undefined })}`;
  assert.equal(defaults.text, 'INSERT INTO users DEFAULT VALUES');
  assert.deepEqual(defaults.values, []);
  const defaultRows = sql`INSERT INTO users ${sql.insertValues<{ name?: string }>([{}, {}], ['name'])}`;
  assert.equal(defaultRows.text, 'INSERT INTO users ("name") VALUES (DEFAULT), (DEFAULT)');
});

test('assignment fragments omit undefined fields, preserve null, and snapshot selected values', () => {
  const input = { name: 'before', bio: null, score: undefined };
  const patch = sql.assignments(input);
  input.name = 'after';
  const query = sql`UPDATE users SET ${patch}, score = score + 1 WHERE id = ${7}`;
  assert.equal(
    query.text,
    'UPDATE users SET "name" = $1, "bio" = $2, score = score + 1 WHERE id = $3',
  );
  assert.deepEqual(query.values, ['before', null, 7]);
  const selected = sql`UPDATE users SET ${sql.assignments({ name: 'x', secret: 'ignored' }, ['name'])}`;
  assert.deepEqual(selected.values, ['x']);
  const exotic = Object.assign(Object.create(null) as { 'a"b': number }, { 'a"b': 3 });
  assert.equal(
    sql`UPDATE users SET ${sql.assignments(exotic)}`.text,
    'UPDATE users SET "a""b" = $1',
  );
});

test('mutation fragments reject empty inputs, invalid columns, accessors, and SQL-valued cells', () => {
  assert.throws(() => sql.insertValues([]), /at least one row/);
  assert.throws(() => sql.insertValues(new Array(1)), /row 1.*plain object/);
  assert.throws(() => sql.insertValues([{}, {}]), /Default-only/);
  assert.throws(() => sql.assignments({}), /at least one defined field/);
  assert.throws(() => sql.assignments({ name: undefined }), /at least one defined field/);
  assert.throws(
    () => sql`UPDATE profiles SET ${sql.assignments({ name: undefined })}, revision = revision + 1`,
    /at least one defined field/,
  );
  assert.throws(() => sql.insertValues({ name: 'x' }, []), /nonempty/);
  assert.throws(() => sql.assignments({ name: 'x' }, ['name', 'name']), /Duplicate/);
  assert.throws(() => sql.insertValues({ '': 'x' }), /1–63 UTF-8 bytes/);
  assert.throws(() => sql.assignments(new Date()), /plain object/);
  assert.throws(() => sql.insertValues([null] as never), /row 1.*plain object/);
  assert.throws(
    () =>
      sql.assignments({
        get name() {
          throw new Error('must not execute');
        },
      }),
    /data property/,
  );
  for (const value of [sql.fragment`revision + 1`, identifier('revision'), sql`SELECT 1`]) {
    assert.throws(
      () => sql.insertValues([{ value: 1 }, { value }]),
      /row 2 column "value" expects a bound value/,
    );
    assert.throws(() => sql.assignments({ value }), /row 1 column "value" expects a bound value/);
  }
});

test('query compilation enforces the combined PostgreSQL bind limit without implicit batching', () => {
  assert.equal(
    unsafeSql(
      'SELECT 1',
      Array.from({ length: 65533 }, () => 1),
    ).values.length,
    65533,
  );
  assert.throws(
    () =>
      unsafeSql(
        'SELECT 1',
        Array.from({ length: 65537 }, () => 1),
      ),
    /65533 bound parameters; received 65537/,
  );
  const rows = Array.from({ length: 65533 }, () => ({ value: 1 }));
  assert.throws(
    () => sql`INSERT INTO users ${sql.insertValues(rows)} RETURNING ${1}`,
    /65533 bound parameters; received 65534/,
  );
});

test('mutation fragments execute defaults, upserts, partial updates and generated-column rules', async () => {
  const pool = postgres(testConnection);
  const db = createTenon({ connection: pool });
  try {
    await assertTestDatabase(pool);
    await migrationProject(pool)(
      {
        '0001_records.up.sql': `CREATE TABLE records (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name text UNIQUE DEFAULT 'default', score integer NOT NULL DEFAULT 7,
        bio text, doubled integer GENERATED ALWAYS AS (score * 2) STORED,
        payload jsonb NOT NULL DEFAULT '[]', tags text[] NOT NULL DEFAULT '{}'
      );`,
      },
      async (options) => {
        await migrate(options);
        const table = identifier(options.namespace, 'records');
        type Row = {
          id: number;
          name: string | null;
          score: number;
          bio: string | null;
          doubled: number;
          payload: unknown;
          tags: string[];
        };
        const created = await db.query(
          sql<Row>`INSERT INTO ${table} ${sql.insertValues([
            { name: 'one' },
            { name: 'two', score: 4, bio: null },
          ])} RETURNING *`,
          { returns: 'many' },
        );
        assert.deepEqual(
          created.map(({ id, ...row }) => row),
          [
            { name: 'one', score: 7, bio: null, doubled: 14, payload: [], tags: [] },
            { name: 'two', score: 4, bio: null, doubled: 8, payload: [], tags: [] },
          ],
        );
        const defaults = await db.query(
          sql<Row>`INSERT INTO ${table} ${sql.insertValues({})} RETURNING *`,
          { returns: 'one' },
        );
        assert.equal(defaults.name, 'default');
        await db.query(sql`INSERT INTO ${table} ${sql.insertValues({ name: 'one', score: 10 })}
        ON CONFLICT (name) DO UPDATE SET score = excluded.score`);
        const changed = await db.query(
          sql<Row>`UPDATE ${table}
        SET ${sql.assignments({ name: undefined, bio: 'changed' })}, score = score + 1
        WHERE name = ${'one'} RETURNING *`,
          { returns: 'one' },
        );
        assert.equal(changed.name, 'one');
        assert.equal(changed.bio, 'changed');
        assert.equal(changed.score, 11);
        assert.equal(changed.doubled, 22);
        const cleared = await db.query(
          sql<Row>`UPDATE ${table} SET ${sql.assignments({ bio: null })}
        WHERE id = ${changed.id} RETURNING *`,
          { returns: 'one' },
        );
        assert.equal(cleared.bio, null);
        const handles = ['ada', 'lin'];
        const arrays = await db.query(
          sql<Row>`INSERT INTO ${table} ${sql.insertValues({
            name: 'arrays',
            payload: handles,
            tags: handles,
          })} RETURNING *`,
          { returns: 'one' },
        );
        assert.deepEqual(arrays.payload, handles);
        assert.deepEqual(arrays.tags, handles);
        await assert.rejects(
          db.transaction(async (tx) => {
            for (const name of ['batch-one', 'batch-two']) {
              await tx.query(sql`INSERT INTO ${table} ${sql.insertValues([{ name }], ['name'])}`);
            }
            throw new Error('cancel all batches');
          }),
          /cancel all batches/,
        );
        const batches = await db.query(
          sql<{ count: string }>`SELECT count(*) AS count FROM ${table}
          WHERE name = ANY(${['batch-one', 'batch-two']}::text[])`,
          { returns: 'one' },
        );
        assert.equal(batches.count, '0');

        await assert.rejects(
          db.query(sql`INSERT INTO ${table} ${sql.insertValues({ id: 99, name: 'invalid' })}`),
          { code: '428C9' },
        );
        await assert.rejects(
          db.query(sql`UPDATE ${table} SET ${sql.assignments({ doubled: 1 })}`),
          { code: '428C9' },
        );
      },
    );
  } finally {
    await db.close();
    await pool.end();
  }
});
