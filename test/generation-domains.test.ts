import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool, type Pool } from '@kequtech/pgclear';
import { createTenon, generateDefinitions, identifier, migrate, sql } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import {
  assertTestDatabase,
  testConnection as connection,
  migrationProject,
} from './helpers/database.js';
import { checkGeneratedTypes, typeAssertions } from './helpers/generation.js';
const pool = createPool({ connectionString: connection });
const project = migrationProject(pool);
before(() => assertTestDatabase(pool));
after(() => pool.close());

test('domains use verified base parsers while retaining ordinary row types and SQL constraints', async () => {
  await project(
    {
      '0001_domains.up.sql': `
    CREATE DOMAIN "Positive" AS integer DEFAULT 3 CONSTRAINT positive_check CHECK (VALUE > 0);
    CREATE DOMAIN "Nested" AS "Positive" CONSTRAINT nested_check CHECK (VALUE < 100);
    CREATE DOMAIN "Big" AS bigint;
    CREATE DOMAIN "Decimal" AS numeric(30, 5);
    CREATE DOMAIN "Flag" AS boolean;
    CREATE DOMAIN "Label" AS varchar(12) COLLATE "C" DEFAULT 'default';
    CREATE DOMAIN "Text" AS text;
    CREATE DOMAIN "Id" AS uuid;
    CREATE DOMAIN "Time" AS timestamptz;
    CREATE DOMAIN "Bytes" AS bytea;
    CREATE DOMAIN "Doc" AS json;
    CREATE DOMAIN "Payload" AS jsonb;
    CREATE TYPE "Kind" AS ENUM ('reader', 'writer');
    CREATE DOMAIN "Role" AS "Kind";
    CREATE DOMAIN "Ints" AS integer[];
    CREATE DOMAIN "Numbers" AS numeric[];
    CREATE DOMAIN "Unused" AS integer;
    CREATE TABLE "DomainValues" (
      number "Nested" NOT NULL, optional "Positive", big "Big" NOT NULL, decimal "Decimal" NOT NULL,
      flag "Flag" NOT NULL, label "Label" NOT NULL, text "Text" NOT NULL, id "Id" NOT NULL,
      time "Time" NOT NULL, bytes "Bytes" NOT NULL, doc "Doc" NOT NULL, payload "Payload",
      role "Role" NOT NULL, ints "Ints" NOT NULL, numbers "Numbers"
    );
  `,
    },
    async (options) => {
      await migrate(options);
      const warnings: string[] = [];
      const source = await generateDefinitions({
        ...options,
        onWarning: (message) => {
          warnings.push(message);
        },
      });
      assert.deepEqual(warnings, []);
      assert.match(
        source,
        /DOMAIN "Positive" AS integer DEFAULT 3\n\/\/   CONSTRAINT "positive_check" CHECK \(\(VALUE > 0\)\)/,
      );
      assert.match(
        source,
        /DOMAIN "Nested" AS "Positive" DEFAULT 3\n\/\/   CONSTRAINT "nested_check" CHECK \(\(\(VALUE\)::integer < 100\)\)/,
      );
      assert.match(source, /DOMAIN "Decimal" AS numeric\(30,5\)/);
      assert.match(
        source,
        /DOMAIN "Label" AS character varying\(12\) COLLATE "C" DEFAULT 'default'::character varying/,
      );
      assert.ok(!source.includes('DOMAIN "Unused"'));
      assert.equal(source.match(/DOMAIN "Positive" AS/g)?.length, 1);
      await checkGeneratedTypes(
        options,
        `
      import type { Database as Schema } from './definitions.js';
type DomainValues = Schema['DomainValues']['row'];
import type { PgArray } from '@kequtech/pgclear';
      import type { Buffer } from 'node:buffer';
      ${typeAssertions}
      type Expected = { number: number; optional: number | null; big: string; decimal: string;
        flag: boolean; label: string; text: string; id: string; time: string; bytes: globalThis.Uint8Array;
        doc: unknown; payload: unknown; role: 'reader' | 'writer';
        ints: PgArray<number>; numbers: PgArray<string> | null };
      type Full = Assert<Equal<DomainValues, Expected>>;
      // Domain CHECK expressions do not create a separate branded type.
      const input: DomainValues['number'] = 42;
    `,
      );
      const db = createTenon({ connection: pool });
      const table = qualified(options.namespace, 'DomainValues');
      try {
        const row = await db.query(
          sql<Record<string, unknown>>`INSERT INTO ${identifier(options.namespace, 'DomainValues')}
        (big, decimal, flag, text, id, time, bytes, doc, payload, role, ints, numbers)
        VALUES ('9007199254740993', 123.45678, true, 'text', '123e4567-e89b-42d3-a456-426614174000',
          '2026-01-01T00:00:00Z', decode('00ff', 'hex'), '{"nested":[1,null]}', 'null', 'reader',
          ARRAY[1,NULL,3], ARRAY[1.25::numeric,NULL]) RETURNING *`,
          { returns: 'one' },
        );
        assert.deepEqual(row, {
          number: 3,
          optional: 3,
          big: '9007199254740993',
          decimal: '123.45678',
          flag: true,
          label: 'default',
          text: 'text',
          id: '123e4567-e89b-42d3-a456-426614174000',
          time: '2026-01-01 00:00:00+00',
          bytes: new Uint8Array([0, 255]),
          doc: { nested: [1, null] },
          payload: null,
          role: 'reader',
          ints: [1, null, 3],
          numbers: ['1.25', null],
        });
        assert.deepEqual(
          await db.query(
            sql`UPDATE ${identifier(options.namespace, 'DomainValues')} SET optional = NULL, numbers = NULL RETURNING optional, numbers`,
            { returns: 'many' },
          ),
          [{ optional: null, numbers: null }],
        );
        await assert.rejects(
          db.query(sql`UPDATE ${identifier(options.namespace, 'DomainValues')} SET number = 0`),
          {
            code: '23514',
            constraint: 'positive_check',
          },
        );
        await assert.rejects(
          db.query(sql`UPDATE ${identifier(options.namespace, 'DomainValues')} SET number = 100`),
          {
            code: '23514',
            constraint: 'nested_check',
          },
        );
      } finally {
        await db.close();
      }
      // Domain-only changes update the comments without changing row types/history.
      await pool.queryClassic(
        `ALTER DOMAIN ${qualified(options.namespace, 'Positive')} SET DEFAULT 4`,
        [],
      );
      await pool.queryClassic(
        `ALTER DOMAIN ${qualified(options.namespace, 'Positive')} ADD CONSTRAINT small CHECK (VALUE < 50) NOT VALID`,
        [],
      );
      const changed = await generateDefinitions(options);
      assert.match(changed, /DOMAIN "Positive" AS integer DEFAULT 4/);
      assert.match(changed, /CONSTRAINT "small" CHECK \(\(VALUE < 50\)\) NOT VALID/);
      assert.notEqual(changed, source);
      assert.equal(
        changed.slice(changed.indexOf('export type ')),
        source.slice(source.indexOf('export type ')),
      );
    },
  );
});

test('domains over arrays retain recursive parser contracts without treating arrays of domains as parsed', async () => {
  await project(
    {
      '0001_domain_arrays.up.sql': `
    CREATE DOMAIN "Positive" AS integer CHECK (VALUE > 0);
    CREATE DOMAIN "DomainArray" AS "Positive"[];
    CREATE DOMAIN "Delay" AS interval;
    CREATE TYPE "Kind" AS ENUM ('a', 'b');
    CREATE DOMAIN "Kinds" AS "Kind"[];
    CREATE TABLE "Arrays" (positive "Positive"[], wrapped "DomainArray", delay "Delay", kinds "Kinds");
  `,
    },
    async (options) => {
      await migrate(options);
      const warnings: string[] = [];
      const opts = {
        ...options,
        onWarning: (message: string) => {
          warnings.push(message);
        },
      };
      const source = await generateDefinitions(opts);
      assert.equal(warnings.length, 0);
      assert.match(source, /DOMAIN "Positive" AS integer/);
      assert.match(source, /DOMAIN "DomainArray" AS "Positive"\[\]/);
      await checkGeneratedTypes(
        { ...options, onWarning: () => {} },
        `
      import type { Database as Schema } from './definitions.js';
type Arrays = Schema['Arrays']['row'];
      ${typeAssertions}
      type Full = Assert<Equal<Arrays, { positive: string | null; wrapped: string | null; delay: string | null; kinds: string | null }>>;
      // @ts-expect-error an array of domains remains wire text
      ({} as Arrays).positive.map(value=>value);
    `,
      );
      const result = (
        await pool.queryClassic(
          `INSERT INTO ${qualified(options.namespace, 'Arrays')}
      (positive, wrapped, delay, kinds) VALUES (ARRAY[2,NULL], ARRAY[3,NULL], INTERVAL '1 day', '{a,b}')
      RETURNING positive, wrapped, kinds`,
          [],
        )
      ).rows;
      assert.deepEqual(
        [...result],
        [{ positive: '{2,NULL}', wrapped: '{3,NULL}', kinds: '{a,b}' }],
      );
    },
  );
});

test('domain comments include external and nested dependencies but preserve conservative column nullability', async () => {
  await project({}, async (external) => {
    await pool.queryClassic(`CREATE SCHEMA ${quote(external.namespace)}`, []);
    const base = qualified(external.namespace, 'Required');
    await pool.queryClassic(
      `CREATE DOMAIN ${base} AS integer NOT NULL CONSTRAINT positive CHECK (VALUE > 0)`,
      [],
    );
    await project(
      {
        '0001_domains.up.sql': `
      CREATE DOMAIN "Nested" AS ${base};
      CREATE TABLE "Values" (optional "Nested", required "Nested" NOT NULL);
    `,
      },
      async (options) => {
        await migrate(options);
        const source = await generateDefinitions(options);
        assert.ok(source.includes(`DOMAIN ${external.namespace}."Required" AS integer NOT NULL`));
        assert.ok(source.includes(`DOMAIN "Nested" AS ${external.namespace}."Required"`));
        await checkGeneratedTypes(
          options,
          `
        import type { Database as Schema } from './definitions.js';
type Values = Schema['Values']['row'];
        ${typeAssertions}
        type Full = Assert<Equal<Values, { optional: number | null; required: number }>>;
      `,
        );
        // PostgreSQL can admit an already-domain-typed NULL through an empty subquery.
        await pool.queryClassic(
          `INSERT INTO ${qualified(options.namespace, 'Values')} (optional, required)
        VALUES ((SELECT optional FROM ${qualified(options.namespace, 'Values')} WHERE false), 1)`,
          [],
        );
        assert.deepEqual(
          [
            ...(
              await pool.queryClassic(
                `SELECT optional, required FROM ${qualified(options.namespace, 'Values')}`,
                [],
              )
            ).rows,
          ],
          [{ optional: null, required: 1 }],
        );
      },
    );
  });
});
