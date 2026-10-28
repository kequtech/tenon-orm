import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool, DatabaseError, types } from 'pg';
import { createTenon, describeQuery, sql, unsafeSql } from '../src/index.js';
import { testConnection } from './helpers/database.js';

test('execution and inspection share pg defaults with SQL NULL array elements preserved', async () => {
  const db = createTenon({ connection: testConnection });
  try {
    const row = await db.query(
      sql<{
        integers: (number | null)[];
        flags: (boolean | null)[];
        texts: (string | null)[];
        decimals: (number | null)[];
        json: unknown;
        big: string;
        infinite: Date | number;
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
    assert.deepEqual(row.decimals, [9007199254740994, null]);
    assert.deepEqual(row.json, { ok: true });
    assert.equal(row.big, '9007199254740993');
    assert.equal(row.infinite, Infinity);
    assert.deepEqual(await db.query(sql`SELECT ${undefined}::text AS value`, { returns: 'many' }), [
      { value: null },
    ]);
    const query = sql`SELECT ${[true, null, false]}::boolean[] AS flags, ${['x', null, 'NULL']}::text[] AS texts,
      ${[9007199254740993n, null]}::bigint[] AS bigs, ${['9007199254740993.25', null]}::numeric[] AS decimals,
      ${JSON.stringify(['one', null])}::jsonb AS json`;
    const values = await db.query(query, { returns: 'one' });
    assert.deepEqual(values, {
      flags: [true, null, false],
      texts: ['x', null, 'NULL'],
      bigs: ['9007199254740993', null],
      decimals: [9007199254740994, null],
      json: ['one', null],
    });
    const described = await describeQuery({ connection: testConnection, query });
    assert.equal(described.context.readMappings, 'pg');
    assert.deepEqual(
      described.columns.map((c) => c.readType),
      ['PgArray<boolean>', 'PgArray<string>', 'PgArray<string>', 'PgArray<number>', 'unknown'],
    );
    await assert.rejects(
      db.transaction((tx) => tx.query(sql`SELECT ${'private-value'}::text + 1`)),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseError);
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

test('borrowed pools retain custom pg parsers without modification', async () => {
  const native = new Pool({
    connectionString: testConnection,
    types: {
      getTypeParser(oid: number, format?: 'text' | 'binary') {
        if (oid === 23) return (value: string) => `int:${value}`;
        if (oid === 1009) return (value: string) => ({ raw: value });
        return types.getTypeParser(oid, format);
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
      integers: [1, null, 3],
      texts: { raw: '{"NULL",NULL}' },
      big: '9007199254740993',
    });
  } finally {
    await db.close();
    await native.end();
  }
});

test("unnamed execution accepts PostgreSQL's full 65535-parameter limit", async (t) => {
  const db = createTenon({ connection: testConnection });
  t.after(() => db.close());
  const size = 65535;
  const query = unsafeSql<{ count: number }>(
    `SELECT cardinality(ARRAY[${Array.from({ length: size }, (_, i) => `$${i + 1}::integer`).join(',')}]) AS count`,
    Array(size).fill(1),
  );
  assert.deepEqual(await db.query(query, { returns: 'one' }), { count: size });
});
