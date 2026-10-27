import assert from 'node:assert/strict';
import { test } from 'node:test';
import postgres from 'postgres';
import { parseArray } from '../src/driver/array.js';
import { createTenon, describeQuery, sql, unsafeSql } from '../src/index.js';
import { testConnection } from './helpers/database.js';

test('array correction distinguishes NULL, quoted NULL, escapes, dimensions and delimiters', () => {
  assert.deepEqual(parseArray('{}', Number), []);
  assert.deepEqual(parseArray('{1,NULL,3}', Number), [1, null, 3]);
  assert.deepEqual(parseArray('{{1,NULL},{NULL,3}}', Number), [
    [1, null],
    [null, 3],
  ]);
  assert.deepEqual(parseArray('[0:2]={1,NULL,3}', Number), [1, null, 3]);
  assert.deepEqual(
    parseArray('{NULL,"NULL","","a,b","a\\"b","a\\\\b"}', (value) => value),
    [null, 'NULL', '', 'a,b', 'a"b', 'a\\b'],
  );
  assert.deepEqual(
    parseArray('{true;NULL;false}', (value) => value === 'true', ';'),
    [true, null, false],
  );
  for (const invalid of ['{1', '{"a"x}', '{}garbage'])
    assert.throws(() => parseArray(invalid, Number));
});

test('execution and inspection share Postgres.js defaults with SQL NULL array elements preserved', async () => {
  const db = createTenon({ connection: testConnection });
  try {
    const row = await db.query(
      sql<{
        integers: (number | null)[];
        flags: (boolean | null)[];
        texts: (string | null)[];
        decimals: (string | null)[];
        json: unknown;
        big: string;
        infinite: Date;
      }>`SELECT ARRAY[1,NULL,3]::integer[] AS integers,
      ARRAY[true,NULL,false]::boolean[] AS flags,
      ARRAY['NULL',NULL,'']::text[] AS texts,
      ARRAY[9007199254740993.25,NULL]::numeric[] AS decimals,
      '{"ok":true}'::jsonb AS json, 9007199254740993::bigint AS big,
      TIMESTAMP 'infinity' AS infinite`,
      { returns: 'one' },
    );
    assert.deepEqual(row.integers, [1, null, 3]);
    assert.deepEqual(row.flags, [true, null, false]);
    assert.deepEqual(row.texts, ['NULL', null, '']);
    assert.deepEqual(row.decimals, ['9007199254740993.25', null]);
    assert.deepEqual(row.json, { ok: true });
    assert.equal(row.big, '9007199254740993');
    assert.ok(row.infinite instanceof Date && Number.isNaN(row.infinite.getTime()));
    await assert.rejects(db.query(sql`SELECT ${undefined}::text`), { code: 'UNDEFINED_VALUE' });
    const query = sql`SELECT ${[true, null, false]}::boolean[] AS flags, ${['x', null, 'NULL']}::text[] AS texts,
      ${[9007199254740993n, null]}::bigint[] AS bigs, ${['9007199254740993.25', null]}::numeric[] AS decimals,
      ${['one', null]}::jsonb AS json`;
    const values = await db.query(query, { returns: 'one' });
    assert.deepEqual(values, {
      flags: [true, null, false],
      texts: ['x', null, 'NULL'],
      bigs: ['9007199254740993', null],
      decimals: ['9007199254740993.25', null],
      json: ['one', null],
    });
    const described = await describeQuery({ connection: testConnection, query });
    assert.equal(described.context.readMappings, 'postgres');
    assert.deepEqual(
      described.columns.map((c) => c.readType),
      ['PgArray<boolean>', 'PgArray<string>', 'PgArray<string>', 'PgArray<string>', 'unknown'],
    );
    await assert.rejects(
      db.transaction((tx) => tx.query(sql`SELECT ${'private-value'}::text + 1`)),
      (error: unknown) => {
        assert.ok(error instanceof postgres.PostgresError);
        assert.equal(error.code, '42883');
        assert.ok(!Object.keys(error).includes('query'));
        assert.ok(!Object.keys(error).includes('parameters'));
        return true;
      },
    );
  } finally {
    await db.close();
  }
});

test('array fix applies even when a borrowed client previously prepared the same SQL', async () => {
  const native = postgres(testConnection);
  const text = 'SELECT ARRAY[1,NULL,3]::integer[] AS values';
  try {
    assert.equal((await native`SELECT current_database() AS name`)[0]!.name, 'tenon_orm_test');
    await native.unsafe(text, [], { prepare: true }).describe();
    const db = createTenon({ connection: native });
    try {
      for (let i = 0; i < 2; i++) {
        const row = await db.query(unsafeSql<{ values: (number | null)[] }>(text, []), {
          returns: 'one',
        });
        assert.deepEqual(row.values, [1, null, 3]);
      }
    } finally {
      await db.close();
    }
    assert.equal((await native`SELECT 1 AS value`)[0]!.value, 1);
  } finally {
    await native.end();
  }
});

test('array correction retains custom scalar parsers and explicit array parsers', async () => {
  const native = postgres(testConnection, {
    types: {
      integer: { to: 23, from: [23], parse: (value: string) => `int:${value}`, serialize: String },
      texts: {
        to: 1009,
        from: [1009],
        parse: (value: string) => ({ raw: value }),
        serialize: String,
      },
    },
  });
  const db = createTenon({ connection: native });
  try {
    const row = await db.query(
      sql`SELECT ARRAY[1,NULL,3]::integer[] AS integers,
      ARRAY['NULL',NULL]::text[] AS texts, 9007199254740993::bigint AS big`,
      { returns: 'one' },
    );
    assert.deepEqual(row, {
      integers: ['int:1', null, 'int:3'],
      texts: { raw: '{"NULL",NULL}' },
      big: '9007199254740993',
    });
  } finally {
    await db.close();
    await native.end();
  }
});
