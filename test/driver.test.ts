import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPool, DatabaseError, defaultCodecs, builtin, param } from '@kequtech/pgclear';
import { createTenon, describeQuery, sql, unsafeSql } from '../src/index.js';
import { testConnection } from './helpers/database.js';

test('execution and inspection share pgclear defaults with SQL NULL array elements preserved', async () => {
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
        infinite: string;
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
    assert.equal(row.infinite, 'infinity');
    // @ts-expect-error Tenon's tag cannot be sent to the native tag API
    await assert.rejects(db.native.query(sql`SELECT 1`), { code: 'PGCLEAR_ENCODE' });
    await assert.rejects(db.query(sql`SELECT ${undefined}::text AS value`), {
      code: 'PGCLEAR_ENCODE',
    });
    assert.deepEqual(
      await db.query(sql`SELECT ${9007199254740993n}::bigint AS value`, { returns: 'one' }),
      { value: '9007199254740993' },
    );
    const query = sql`SELECT ${'{t,NULL,f}'}::boolean[] AS flags, ${param(['x', null, 'NULL'], builtin.textArray)}::text[] AS texts,
      ${param(['9007199254740993', null], builtin.int8Array)}::bigint[] AS bigs, ${param(['9007199254740993.25', null], builtin.numericArray)}::numeric[] AS decimals,
      ${JSON.stringify(['one', null])}::jsonb AS json`;
    const values = await db.query(query, { returns: 'one' });
    assert.deepEqual(values, {
      flags: [true, null, false],
      texts: ['x', null, 'NULL'],
      bigs: ['9007199254740993', null],
      decimals: ['9007199254740993.25', null],
      json: ['one', null],
    });
    const described = await describeQuery({ connection: testConnection, query });
    assert.equal(described.context.readMappings, 'pgclear');
    assert.deepEqual(
      described.columns.map((c) => c.readType),
      ['PgArray<boolean>', 'PgArray<string>', 'PgArray<string>', 'PgArray<string>', 'unknown'],
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

test('borrowed pools retain custom pgclear codecs without modification', async () => {
  const native = createPool({
    connectionString: testConnection,
    codecs: defaultCodecs
      .with({ oid: 23, text: { encode: String, decode: (value) => 'int:' + value } })
      .with({ oid: 1009, text: { encode: String, decode: (value) => ({ raw: value }) } }),
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
    await native.close();
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

test('Unicode field names, leading BOMs and array whitespace agree between Describe and execution', async () => {
  const db = createTenon({ connection: testConnection });
  try {
    const name = '\uFEFFvalue';
    const query = unsafeSql(
      `SELECT chr(65279) || 'hello' AS "${name}",
        ARRAY[chr(160) || 'hello', 'hello' || chr(160), chr(8195), chr(65279)] AS items`,
      [],
    );
    const description = await describeQuery({ connection: testConnection, query });
    assert.deepEqual(
      description.columns.map(({ name }) => name),
      [name, 'items'],
    );
    assert.deepEqual(await db.query(query, { returns: 'one' }), {
      [name]: '\uFEFFhello',
      items: ['\u00A0hello', 'hello\u00A0', '\u2003', '\uFEFF'],
    });
  } finally {
    await db.close();
  }
});

test('Describe uses the selected scalar and array codecs and reports unknown custom decoders', async () => {
  const codecs = defaultCodecs
    .with({ oid: 23, text: builtin.int8.text! })
    .with({ oid: 1009, text: builtin.text.text! })
    .with(builtin.jsonbText);
  const db = createTenon({ connection: { connectionString: testConnection, codecs } });
  const query = sql`SELECT 42::integer AS id, ARRAY[1,NULL]::integer[] AS ids,
    ARRAY['a',NULL]::text[] AS labels, '{"ok":true}'::jsonb AS payload`;
  try {
    const described = await describeQuery({ connection: testConnection, query, codecs });
    assert.deepEqual(
      described.columns.map(({ readType }) => readType),
      ['string', 'PgArray<string>', 'string', 'string'],
    );
    assert.deepEqual(await db.query(query, { returns: 'one' }), {
      id: '42',
      ids: ['1', null],
      labels: '{a,NULL}',
      payload: '{"ok": true}',
    });
    assert.ok(!described.issues.some(({ code }) => code === 'unmapped-type'));

    const unknown = defaultCodecs.with({
      oid: 23,
      text: { encode: String, decode: (text) => ({ value: text }) },
    });
    const unproven = await describeQuery({ connection: testConnection, query, codecs: unknown });
    assert.deepEqual(
      unproven.columns.map(({ readType }) => readType),
      ['unknown', 'unknown', 'PgArray<string>', 'unknown'],
    );
    assert.deepEqual(
      unproven.issues
        .filter(({ code }) => code === 'unmapped-type')
        .map((issue) => issue.code === 'unmapped-type' && issue.oid),
      [23, 1007],
    );
    assert.equal(
      (await describeQuery({ connection: testConnection, query })).columns[0]!.readType,
      'number',
    );
  } finally {
    await db.close();
  }
});

test('Describe accepts public parameter OID hints without evaluating or encoding values', async () => {
  const result = await describeQuery({
    connection: testConnection,
    query: {
      text: 'SELECT $1 IS NULL AS missing',
      parameterTypes: [23],
      get values(): never {
        throw new Error('Describe must not inspect values.');
      },
    } as { text: string; parameterTypes: number[] },
  });
  assert.equal(result.parameters[0]!.oid, 23);
  assert.equal(result.columns[0]!.readType, 'boolean');
});
