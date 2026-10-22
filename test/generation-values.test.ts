import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import tenon, { generateDefinitions, migrate } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import {
  assertTestDatabase,
  testConnection as connection,
  migrationProject,
} from './helpers/database.js';
import { checkGeneratedTypes, typeAssertions } from './helpers/generation.js';
const pool = new Pool({ connectionString: connection });
const project = migrationProject(pool);
before(() => assertTestDatabase(pool));
after(() => pool.end());

test('generated values follow standard pg parsing for bigint, numeric, JSON and bytea', async () => {
  await project(
    {
      '0001_values.up.sql': `
    CREATE TABLE "Values" (
      id INTEGER PRIMARY KEY, big BIGINT NOT NULL, decimal NUMERIC NOT NULL,
      payload JSONB NOT NULL, document JSON NOT NULL, bytes BYTEA NOT NULL,
      maybe_big BIGINT, maybe_decimal NUMERIC, maybe_json JSONB, maybe_bytes BYTEA
    );
    CREATE TABLE "Buffer" (bytes BYTEA NOT NULL);
  `,
    },
    async (options) => {
      await migrate(options);
      await checkGeneratedTypes(
        options,
        `
      import type { Values, Buffer as BufferRow } from './definitions.js';
      import type { Buffer as NodeBuffer } from 'node:buffer';
      ${typeAssertions}
      type Expected = {
        id: number; big: string; decimal: string; payload: unknown; document: unknown; bytes: NodeBuffer;
        maybe_big: string | null; maybe_decimal: string | null; maybe_json: unknown; maybe_bytes: NodeBuffer | null;
      };
      type Full = Assert<Equal<Values, Expected>>;
      type Binary = Assert<Equal<BufferRow['bytes'], NodeBuffer>>;
      // @ts-expect-error bigint is returned as text, preserving its precision
      const rounded: Values['big'] = 9007199254740993;
      // @ts-expect-error JSON fields require an application-specific contract or narrowing
      const guessed: string = ({} as Values).payload.name;
    `,
      );
      const target = qualified(options.namespace, 'Values');
      const big = '-9223372036854775808';
      const decimal = '12345678901234567890.1234567890123456789';
      const bytes = Buffer.from([0, 255, 1, 128]);
      type ValueRow = {
        id: number;
        big: string;
        decimal: string;
        payload: unknown;
        document: unknown;
        bytes: Buffer;
        maybe_big: string | null;
        maybe_decimal: string | null;
        maybe_json: unknown;
        maybe_bytes: Buffer | null;
      };
      const db = tenon({ connection: pool });
      try {
        const row = await db.sql<ValueRow>(
          `INSERT INTO ${target} (id, big, decimal, payload, document, bytes) VALUES ($1, $2, $3, $4, $5::json, $6) RETURNING *`,
          [1, big, decimal, { nested: [1, false, null] }, 'null', bytes],
          { returns: 'requiredOne' },
        );
        assert.deepEqual(row, {
          id: 1,
          big,
          decimal,
          payload: { nested: [1, false, null] },
          document: null,
          bytes,
          maybe_big: null,
          maybe_decimal: null,
          maybe_json: null,
          maybe_bytes: null,
        });
        assert.ok(Buffer.isBuffer(row.bytes));
        const scalar = await db.sql<{ payload: unknown; document: unknown }>(
          `UPDATE ${target} SET payload = $1::jsonb, document = $2::json WHERE id = 1 RETURNING payload, document`,
          ['42', '"text"'],
          { returns: 'requiredOne' },
        );
        assert.deepEqual(scalar, { payload: 42, document: 'text' });
        assert.deepEqual(
          await db.sql<object>(
            'SELECT 9007199254740993::bigint AS value, 1.25::numeric AS decimal',
            [],
            { returns: 'many' },
          ),
          [{ value: '9007199254740993', decimal: '1.25' }],
        );
      } finally {
        await db.close();
      }
    },
  );
});

test('recursive generated arrays match every supported pg array parser', async () => {
  await project(
    {
      '0001_arrays.up.sql': `
    CREATE TABLE "ArrayValues" (
      id INTEGER NOT NULL, ints INTEGER[] NOT NULL, bigs BIGINT[] NOT NULL,
      decimals NUMERIC[] NOT NULL, texts TEXT[] NOT NULL, strings VARCHAR[] NOT NULL,
      flags BOOLEAN[] NOT NULL, ids UUID[] NOT NULL, times TIMESTAMPTZ[] NOT NULL,
      bytes BYTEA[] NOT NULL, docs JSON[] NOT NULL, payloads JSONB[] NOT NULL,
      optional INTEGER[]
    );
    CREATE TABLE "PgArray" (id INTEGER NOT NULL);
    CREATE TABLE "Array" (id INTEGER NOT NULL);
  `,
    },
    async (options) => {
      await migrate(options);
      await checkGeneratedTypes(
        options,
        `
      import type { ArrayValues, PgArray, Rows, Array as ArrayRow } from './definitions.js';
      import type { Buffer as NodeBuffer } from 'node:buffer';
      ${typeAssertions}
      type Expected = {
        id: number; ints: PgArray<number>; bigs: PgArray<string>; decimals: PgArray<number>;
        texts: PgArray<string>; strings: PgArray<string>; flags: PgArray<boolean>;
        ids: PgArray<string>; times: PgArray<globalThis.Date>; bytes: PgArray<NodeBuffer>;
        docs: PgArray<unknown>; payloads: PgArray<unknown>; optional: PgArray<number> | null;
      };
      type Complete = Assert<Equal<ArrayValues, Expected>>;
      type NameCollision = Assert<Equal<Rows['PgArray'], { id: number }>>;
      type GlobalCollision = Assert<Equal<ArrayRow, { id: number }>>;
      const flat: PgArray<number> = [1, null, 2];
      const nested: PgArray<number> = [[1, null], [2, 3]];
      const empty: PgArray<number> = [];
      // @ts-expect-error array leaves preserve their parsed scalar types
      const badLeaf: PgArray<number> = ['one'];
      // @ts-expect-error NOT NULL does not make a database array flat or exclude null elements
      const assumedFlat: number[] = ({} as ArrayValues).ints;
      // @ts-expect-error the complete NOT NULL array column is not nullable
      const nullArray: ArrayValues['ints'] = null;
      const nullableArray: ArrayValues['optional'] = null;
    `,
      );
      const db = tenon({ connection: pool });
      const target = qualified(options.namespace, 'ArrayValues');
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const date = new Date('2026-10-21T12:34:56.789Z');
      const binary = Buffer.from([0, 255, 1, 128]);
      try {
        const inserted = await db.sql<Record<string, unknown>>(
          `
        INSERT INTO ${target} (id, ints, bigs, decimals, texts, strings, flags, ids, times, bytes, docs, payloads)
        VALUES (1, $1::integer[], $2::bigint[], $3::numeric[], $4::text[], $5::varchar[],
          $6::boolean[], $7::uuid[], $8::timestamptz[], $9::bytea[],
          ARRAY['{"nested":[1]}'::json, 'null'::json, NULL],
          ARRAY['42'::jsonb, '"text"'::jsonb, NULL]) RETURNING *`,
          [
            [
              [1, null],
              [2, 3],
            ],
            ['9223372036854775807', null, '-9223372036854775808'],
            ['9007199254740993.125', null, '1.25'],
            ['NULL', 'comma, braces{}', 'quote"slash\\', '', null],
            ['bounded', null],
            [false, null, true],
            [uuid, null],
            [date, null],
            [binary, null, Buffer.alloc(0)],
          ],
        );
        assert.deepEqual(inserted.rows, [
          {
            id: 1,
            ints: [
              [1, null],
              [2, 3],
            ],
            bigs: ['9223372036854775807', null, '-9223372036854775808'],
            decimals: [9007199254740994, null, 1.25],
            texts: ['NULL', 'comma, braces{}', 'quote"slash\\', '', null],
            strings: ['bounded', null],
            flags: [false, null, true],
            ids: [uuid, null],
            times: [date, null],
            bytes: [binary, null, Buffer.alloc(0)],
            docs: [{ nested: [1] }, null, null],
            payloads: [42, 'text', null],
            optional: null,
          },
        ]);
        const bounds = await db.sql<{ ints: (number | null)[] }>(
          `UPDATE ${target} SET ints = '[0:1]={5,NULL}'::integer[] RETURNING ints`,
          [],
          { returns: 'requiredOne' },
        );
        assert.deepEqual(bounds, { ints: [5, null] });
        const columns = [
          'ints',
          'bigs',
          'decimals',
          'texts',
          'strings',
          'flags',
          'ids',
          'times',
          'bytes',
          'docs',
          'payloads',
          'optional',
        ];
        const empty = await db.sql<Record<string, unknown>>(
          `UPDATE ${target} SET ${columns.map((name) => `${quote(name)} = '{}'`).join(', ')} RETURNING *`,
          [],
        );
        assert.deepEqual(empty.rows, [
          { id: 1, ...Object.fromEntries(columns.map((name) => [name, []])) },
        ]);
      } finally {
        await db.close();
      }
    },
  );
});

test('unmapped columns generate unknown with actionable warnings while verified mappings stay precise', async () => {
  await project(
    {
      '0001_mixed.up.sql': `
    CREATE TYPE "Kind" AS ENUM ('a', 'b');
    CREATE DOMAIN "Positive" AS INTEGER CHECK (VALUE > 0);
    CREATE TYPE "Details" AS (label TEXT);
    CREATE TABLE "Mixed" (
      id INTEGER NOT NULL, name TEXT NOT NULL, payload JSONB,
      duration INTERVAL NOT NULL, optional_duration INTERVAL,
      kinds "Kind"[], amount "Positive", details "Details",
      kind "Kind" NOT NULL, integers INTEGER[]
    );
  `,
    },
    async (options) => {
      await migrate(options);
      const warnings: string[] = [];
      const source = await generateDefinitions({
        ...options,
        onWarning: (message) => warnings.push(message),
      });
      const columns = ['duration', 'optional_duration', 'kinds', 'details'];
      assert.equal(warnings.length, columns.length);
      for (const column of columns) {
        const warning = warnings.find((message) =>
          message.includes(`${quote(options.namespace)}."Mixed".${quote(column)}`),
        );
        assert.ok(warning, `Missing warning for ${column}`);
        assert.match(warning, /\(OID \d+\)/);
      }
      assert.ok(warnings.some((message) => message.includes('"pg_catalog"."interval"')));
      assert.ok(!warnings.some((message) => message.includes('"amount"')));
      // Warning handling does not affect deterministic generated output.
      assert.equal(await generateDefinitions({ ...options, onWarning: () => {} }), source);
      await checkGeneratedTypes(
        { ...options, onWarning: () => {} },
        `
      import type { Mixed, Rows, PgArray } from './definitions.js';
      ${typeAssertions}
      type Expected = {
        id: number; name: string; payload: unknown;
        duration: unknown; optional_duration: unknown;
        kinds: unknown; amount: number | null; details: unknown;
        kind: 'a' | 'b'; integers: PgArray<number> | null;
      };
      type Complete = Assert<Equal<Mixed, Expected>>;
      type Mapped = Assert<Equal<Rows['Mixed'], Expected>>;
      const row = {} as Mixed;
      // @ts-expect-error unknown values require narrowing or an explicit contract
      row.duration.days;
      // @ts-expect-error an unsupported array parser does not imply an array value
      row.kinds.map(value => value);
      // @ts-expect-error unknown columns are still required in full returned rows
      const missing: Mixed = { id: 1, name: 'example', payload: null, kind: 'a', integers: [] };
      const nullable: Mixed['optional_duration'] = null;
    `,
      );
    },
  );
});

test('unverified array parsers warn and generate unknown without changing driver values', async (t) => {
  await project(
    {
      '0001_enum_array.up.sql': `CREATE TYPE "Kind" AS ENUM ('a', 'b'); CREATE TABLE "Custom" (kinds "Kind"[]);`,
    },
    async (options) => {
      await migrate(options);
      const result = await pool.query(
        `SELECT ARRAY['a'::${qualified(options.namespace, 'Kind')}, NULL] AS kinds`,
      );
      assert.equal(typeof result.rows[0].kinds, 'string');
      assert.equal(result.rows[0].kinds, '{a,NULL}');
      const warnings: string[] = [];
      const warn = t.mock.method(console, 'warn', (message: string) => {
        warnings.push(message);
      });
      try {
        await generateDefinitions(options);
      } finally {
        warn.mock.restore();
      }
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0]!.includes('"Custom"."kinds"'));
      assert.ok(warnings[0]!.includes('"_Kind"'));
      await checkGeneratedTypes(
        { ...options, onWarning: () => {} },
        `
      import type { Custom } from './definitions.js';
      ${typeAssertions}
      type Unverified = Assert<Equal<Custom, { kinds: unknown }>>;
      // @ts-expect-error no verified array type is emitted for this parser
      import type { PgArray } from './definitions.js';
    `,
      );
    },
  );
});
