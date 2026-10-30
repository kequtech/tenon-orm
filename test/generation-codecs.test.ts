import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { builtin, createPool, defaultCodecs } from '@kequtech/pgclear';
import { generateDefinitions, migrate } from '../src/index.js';
import { writeDefinitions } from '../src/generation/output.js';
import { qualified } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';
import { checkGeneratedTypes, typeAssertions } from './helpers/generation.js';

const run = promisify(execFile);
const pool = createPool({ connectionString: testConnection });
const project = migrationProject(pool);
before(() => assertTestDatabase(pool));
after(() => pool.close());

test('generation uses declared scalar and derived-array outputs while catalog decoding stays native', async () => {
  await project(
    {
      '0001_represented.up.sql': `CREATE TABLE "Represented" (
        number integer NOT NULL, optional integer, numbers integer[], flag boolean NOT NULL,
        bytes bytea, nested jsonb, model text, id bigint, at timestamptz, bigs bigint[]
      );
      CREATE TABLE "NestedOnly" (wrapped jsonb);`,
    },
    async (options) => {
      await migrate(options);
      await pool.queryClassic(
        `INSERT INTO ${qualified(options.namespace, 'Represented')}
          VALUES (7, NULL, ARRAY[1,NULL,3], true, decode('00ff', 'hex'),
            '{"items":["first",null]}', 'example', 9007199254740993,
            TIMESTAMPTZ '2026-10-29 12:34:56.123+00', ARRAY[9007199254740993::bigint,NULL])`,
      );
      await writeFile(
        join(options.directory, 'model.ts'),
        'export type Model = { label: string };',
      );
      const codecs = defaultCodecs
        .with({
          oid: 2278,
          text: {
            encode: () => '',
            decode: () => {
              throw new Error('Application void codec must not decode migration lock results.');
            },
            typescript: 'never',
          },
        })
        .with(builtin.int8BigInt)
        .with(builtin.timestamptzDate)
        .with({
          oid: 23,
          text: {
            encode: (value: () => number) => String(value()),
            decode: (value: string) => () => Number(value),
            typescript: '() => number',
          },
        })
        .with({
          oid: 16,
          text: {
            encode: (value: 'yes' | 'no') => (value === 'yes' ? 't' : 'f'),
            decode: (value: string) => (value === 't' ? 'yes' : 'no'),
            typescript: '"yes" | "no"',
          },
        })
        .with({
          oid: 26,
          text: { encode: String, decode: (value) => `oid:${value}`, typescript: 'string' },
        })
        .with({
          oid: 19,
          text: {
            encode: (value: { name: string }) => value.name,
            decode: (value: string) => ({ name: value }),
            typescript: '{ name: string }',
          },
        })
        .with({
          oid: 17,
          text: {
            encode: (value: Buffer) => '\\x' + value.toString('hex'),
            decode: (value: string) => Buffer.from(value.slice(2), 'hex'),
            typescript: 'import("node:buffer").Buffer',
          },
        })
        .with({
          oid: 3802,
          text: {
            encode: (value: { items: (string | null)[] }) => JSON.stringify(value),
            decode: (value: string) => JSON.parse(value) as { items: (string | null)[] },
            typescript: '{ items: PgArray <string> }',
          },
        })
        .with({
          oid: 25,
          text: {
            encode: (value: { label: string }) => value.label,
            decode: (value: string) => ({ label: value }),
            typescript: 'import("./model.js").Model',
          },
        });
      const configured = createPool({
        connectionString: testConnection,
        maxConnections: 1,
        codecs,
      });
      try {
        const warnings: string[] = [];
        await checkGeneratedTypes(
          {
            ...options,
            connection: configured,
            onWarning: (message) => {
              warnings.push(message);
            },
          },
          `
          import type { Database } from './definitions.js';
          import type { PgArray, Parameter } from '@kequtech/pgclear';
          import type { Buffer } from 'node:buffer';
          import type { Model } from './model.js';
          ${typeAssertions}
          type Row = Database['Represented']['row'];
          type NumberRead = Assert<Equal<Row['number'], () => number>>;
          type NullableFunction = Assert<Equal<Row['optional'], (() => number) | null>>;
          type DerivedArray = Assert<Equal<Row['numbers'], PgArray<() => number> | null>>;
          type Flag = Assert<Equal<Row['flag'], 'yes' | 'no'>>;
          type Bytes = Assert<Equal<Row['bytes'], Buffer | null>>;
          type Nested = Assert<Equal<Row['nested'], {items: PgArray<string>} | null>>;
          type Imported = Assert<Equal<Row['model'], Model | null>>;
          type BigInteger = Assert<Equal<Row['id'], bigint | null>>;
          type DateOutput = Assert<Equal<Row['at'], Date | null>>;
          type BigArray = Assert<Equal<Row['bigs'], PgArray<bigint> | null>>;
          type NestedOnly = Assert<Equal<Database['NestedOnly']['row']['wrapped'], {items: PgArray<string>} | null>>;
          type PlainWrite = Assert<Equal<Database['Represented']['insert']['number'], number | Parameter>>;
          // @ts-expect-error a nullable function requires narrowing before invocation
          ({} as Row).optional();
          `,
        );
        await run(process.execPath, [
          resolve('node_modules/typescript-next/bin/tsc'),
          '--project',
          join(options.directory, 'tsconfig.json'),
        ]);
        assert.deepEqual(warnings, []);
        const row = (
          await configured.queryClassic(
            `SELECT * FROM ${qualified(options.namespace, 'Represented')}`,
          )
        ).rows[0]!;
        assert.ok(typeof row.number === 'function');
        assert.equal(row.number(), 7);
        assert.equal(row.optional, null);
        assert.ok(Array.isArray(row.numbers));
        assert.deepEqual(
          row.numbers.map((value: unknown) => (typeof value === 'function' ? value() : value)),
          [1, null, 3],
        );
        assert.equal(row.flag, 'yes');
        assert.ok(Buffer.isBuffer(row.bytes));
        assert.deepEqual([...row.bytes], [0, 255]);
        assert.deepEqual(row.nested, { items: ['first', null] });
        assert.deepEqual(row.model, { label: 'example' });
        assert.equal(row.id, 9007199254740993n);
        assert.ok(row.at instanceof Date);
        assert.equal(row.at.toISOString(), '2026-10-29T12:34:56.123Z');
        assert.deepEqual(row.bigs, [9007199254740993n, null]);
        assert.equal(configured.codecs, codecs);
      } finally {
        await configured.close();
      }
    },
  );
});

test('explicit array output overrides take precedence over a custom scalar representation', async () => {
  await project(
    { '0001_arrays.up.sql': 'CREATE TABLE "Arrays" (scalar integer NOT NULL, items integer[]);' },
    async (options) => {
      await migrate(options);
      const configured = createPool({
        connectionString: testConnection,
        codecs: defaultCodecs
          .with({
            oid: 23,
            text: {
              encode: (value: { value: string }) => value.value,
              decode: (value: string) => ({ value }),
              typescript: '{ value: string }',
            },
          })
          .with({
            oid: 1007,
            text: {
              encode: (value: { raw: string }) => value.raw,
              decode: (raw: string) => ({ raw }),
              typescript: '{ raw: string }',
            },
          }),
      });
      try {
        await checkGeneratedTypes(
          { ...options, connection: configured },
          `
          import type { Database } from './definitions.js';
          import type { Parameter } from '@kequtech/pgclear';
          ${typeAssertions}
          type Row = Database['Arrays']['row'];
          type Scalar = Assert<Equal<Row['scalar'], {value: string}>>;
          type ArrayOverride = Assert<Equal<Row['items'], {raw: string} | null>>;
          type ArrayWrite = Assert<Equal<Database['Arrays']['insert']['items'], string | Parameter | null | undefined>>;
          `,
        );
        assert.deepEqual(
          (
            await configured.queryClassic(
              `INSERT INTO ${qualified(options.namespace, 'Arrays')}
                VALUES (42, ARRAY[1,NULL,3]) RETURNING *`,
            )
          ).rows,
          [{ scalar: { value: '42' }, items: { raw: '{1,NULL,3}' } }],
        );
      } finally {
        await configured.close();
      }
    },
  );
});

test('unrelated codec overrides preserve enum and enum-domain unions alongside Date output', async () => {
  await project(
    {
      '0001_enum.up.sql': `CREATE TYPE "State" AS ENUM ('queued', 'done');
        CREATE DOMAIN "DomainState" AS "State";
        CREATE DOMAIN "NestedState" AS "DomainState";
        CREATE TABLE "Entries" (
          state "State" NOT NULL, optional "State", wrapped "NestedState" NOT NULL,
          at timestamptz NOT NULL
        );`,
    },
    async (options) => {
      await migrate(options);
      for (const codecs of [
        defaultCodecs.with(builtin.timestamptzDate),
        defaultCodecs.with(builtin.timestamptzDate).with(builtin.int8BigInt),
      ]) {
        const configured = createPool({ connectionString: testConnection, codecs });
        try {
          const warnings: string[] = [];
          await checkGeneratedTypes(
            {
              ...options,
              connection: configured,
              onWarning: (message) => {
                warnings.push(message);
              },
            },
            `
            import type { Database } from './definitions.js';
            import type { Parameter } from '@kequtech/pgclear';
            ${typeAssertions}
            type Row = Database['Entries']['row'];
            type Expected = {
              state: 'queued' | 'done'; optional: 'queued' | 'done' | null;
              wrapped: 'queued' | 'done'; at: Date;
            };
            type Read = Assert<Equal<Row, Expected>>;
            type Insert = Assert<Equal<Database['Entries']['insert']['state'], 'queued' | 'done' | Parameter>>;
            type Update = Assert<Equal<Database['Entries']['update']['state'], 'queued' | 'done' | Parameter | undefined>>;
            `,
          );
          assert.deepEqual(warnings, []);
          const row = (
            await configured.queryClassic(
              `INSERT INTO ${qualified(options.namespace, 'Entries')}
                VALUES ('queued', NULL, 'done', TIMESTAMPTZ '2026-10-30 12:34:56.123+00')
                RETURNING *`,
            )
          ).rows[0]!;
          assert.deepEqual(row, {
            state: 'queued',
            optional: null,
            wrapped: 'done',
            at: new Date('2026-10-30T12:34:56.123Z'),
          });
        } finally {
          await configured.close();
        }
      }
    },
  );
});

test('custom enum decoders retain their own read types while writes retain catalog choices', async () => {
  await project(
    {
      '0001_enum.up.sql': `CREATE TYPE "Kind" AS ENUM ('reader', 'writer');
        CREATE TABLE "Entries" (kind "Kind" NOT NULL);`,
    },
    async (options) => {
      await migrate(options);
      const description = await pool.describe(
        `SELECT kind FROM ${qualified(options.namespace, 'Entries')}`,
      );
      const oid = description.fields[0]!.dataTypeOid;
      for (const typescript of ['string', "'READER' | 'WRITER'", undefined]) {
        const configured = createPool({
          connectionString: testConnection,
          codecs: defaultCodecs.with(builtin.timestamptzDate).with({
            oid,
            text: {
              encode: (value: string) => value.toLowerCase(),
              decode: (value: string) => value.toUpperCase(),
              ...(typescript === undefined ? {} : { typescript }),
            },
          }),
        });
        try {
          const warnings: string[] = [];
          await checkGeneratedTypes(
            {
              ...options,
              connection: configured,
              onWarning: (message) => {
                warnings.push(message);
              },
            },
            `
          import type { Database } from './definitions.js';
          import type { Parameter } from '@kequtech/pgclear';
          ${typeAssertions}
          type CustomRead = Assert<Equal<Database['Entries']['row']['kind'], ${typescript ?? 'unknown'}>>;
          type Writes = Assert<Equal<Database['Entries']['insert']['kind'], 'reader' | 'writer' | Parameter>>;
          // @ts-expect-error transformed output text is not a valid plain database label
          const invalid: Database['Entries']['insert'] = {kind: 'READER'};
          `,
          );
          assert.equal(warnings.length, typescript === undefined ? 1 : 0);
          assert.deepEqual(
            (
              await configured.queryClassic(
                `INSERT INTO ${qualified(options.namespace, 'Entries')} VALUES ($1) RETURNING kind`,
                ['reader'],
              )
            ).rows,
            [{ kind: 'READER' }],
          );
        } finally {
          await configured.close();
        }
      }
    },
  );
});

test('generation restores borrowed session settings and temporary state and keeps a failed pool usable', async () => {
  await project(
    { '0001_unknown.up.sql': 'CREATE TABLE "Unknown" (value integer NOT NULL);' },
    async (options) => {
      await migrate(options);
      const configured = createPool({
        connectionString: testConnection,
        maxConnections: 1,
        startupParameters: {
          search_path: 'public',
          quote_all_identifiers: 'on',
          standard_conforming_strings: 'off',
        },
        codecs: defaultCodecs.with({
          oid: 23,
          text: { encode: String, decode: (value) => ({ value }) },
        }),
      });
      const state = `SELECT current_setting('search_path') AS path,
        current_setting('quote_all_identifiers') AS quoted,
        current_setting('standard_conforming_strings') AS strings,
        pg_backend_pid()::text AS backend`;
      try {
        await configured.withSession((session) =>
          session.script(`CREATE TEMP TABLE generation_codec_marker (value text);
            INSERT INTO generation_codec_marker VALUES ('retained');`),
        );
        const before = (await configured.queryClassic(state)).rows[0]!;
        const warnings: string[] = [];
        await checkGeneratedTypes(
          {
            ...options,
            connection: configured,
            onWarning: async (message) => {
              await Promise.resolve();
              warnings.push(message);
            },
          },
          `
          import type { Database } from './definitions.js';
          ${typeAssertions}
          type Unidentified = Assert<Equal<Database['Unknown']['row']['value'], unknown>>;
          `,
        );
        assert.equal(warnings.length, 1);
        assert.deepEqual((await configured.queryClassic(state)).rows[0], before);
        assert.deepEqual(
          (await configured.queryClassic('SELECT value FROM generation_codec_marker')).rows,
          [{ value: 'retained' }],
        );
        const failure = new Error('application warning handler failed');
        const out = join(options.directory, 'definitions.ts');
        const saved = await readFile(out, 'utf8');
        await assert.rejects(
          async () => {
            const source = await generateDefinitions({
              connection: configured,
              namespace: options.namespace,
              onWarning: async () => {
                await Promise.resolve();
                throw failure;
              },
            });
            await writeDefinitions(source, out, false);
          },
          (error) => error === failure,
        );
        assert.equal(await readFile(out, 'utf8'), saved);
        // Tooling discards a failed checkout, but the borrowed pool remains application-owned.
        const after = (await configured.queryClassic(state)).rows[0]!;
        assert.deepEqual(
          { path: after.path, quoted: after.quoted, strings: after.strings },
          { path: before.path, quoted: before.quoted, strings: before.strings },
        );
        assert.equal(configured.stats.leased, 0);
        assert.equal(configured.stats.waiting, 0);
        assert.equal(
          (
            await configured.queryClassic<{ value: number }>('SELECT 42 AS value', [], {
              codecs: defaultCodecs,
            })
          ).rows[0]!.value,
          42,
        );
      } finally {
        await configured.close();
      }
    },
  );
});
