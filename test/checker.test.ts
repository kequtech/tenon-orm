import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { builtin, createPool, defaultCodecs } from '@kequtech/pgclear';
import { checkQueries, type CheckOptions, type CheckReport } from '../src/check.js';
import { migrate } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const pool = createPool(testConnection);
before(() => assertTestDatabase(pool));
after(() => pool.close());
const run = promisify(execFile);
const tag = "import { sql, unsafeSql, identifier } from '@kequtech/tenon-orm';";

async function sourceProject(
  files: Record<string, string>,
  work: (options: CheckOptions, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-checker-'));
  try {
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          target: 'ES2022',
          lib: ['ES2024'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: true,
          noEmit: true,
          types: ['node'],
          typeRoots: [resolve('node_modules/@types')],
          paths: {
            '@kequtech/tenon-orm': [resolve('dist/index.d.ts')],
            '@kequtech/pgclear': [resolve('node_modules/@kequtech/pgclear/dist/index.d.ts')],
          },
        },
        include: ['**/*.ts'],
      }),
    );
    for (const [name, source] of Object.entries(files)) {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), source);
    }
    await work(
      { connection: testConnection, project: join(directory, 'tsconfig.json') },
      directory,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function errors(report: CheckReport) {
  return report.diagnostics.filter(({ kind }) => kind !== 'unproven');
}

test('codec metadata resolves imported scalar types, derived arrays and explicit array overrides', async () => {
  await sourceProject(
    {
      'model.ts': [
        'export interface Value { raw: string }',
        'export interface ArrayValue { rawArray: string }',
        'throw new Error("Application type modules must never execute");',
      ].join('\n'),
      'queries.ts': [
        tag,
        "import type {Value} from './model.js';",
        "import type {PgArray} from '@kequtech/pgclear';",
        'export const output = sql<{id: Value; ids: PgArray<Value>}>`SELECT 42::integer AS id, ARRAY[1,NULL,2]::integer[] AS ids`;',
      ].join('\n'),
      'array.ts': [
        tag,
        "import type {ArrayValue} from './model.js';",
        'export const output = sql<{ids: ArrayValue}>`SELECT ARRAY[1,NULL,2]::integer[] AS ids`;',
      ].join('\n'),
    },
    async (options, directory) => {
      const codecs = defaultCodecs.with({
        oid: 23,
        text: {
          encode: String,
          decode: (raw) => ({ raw }),
          typescript: 'import("./model.js").Value',
        },
      });
      const target = join(directory, 'queries.ts');
      const derived = await checkQueries({ ...options, target, codecs });
      assert.equal(derived.ok, true, JSON.stringify(derived.diagnostics));
      assert.ok(!derived.diagnostics.some(({ code }) => code === 'result-representation-unproven'));
      const overridden = await checkQueries({
        ...options,
        target: join(directory, 'array.ts'),
        codecs: codecs.with({
          oid: 1007,
          text: {
            encode: String,
            decode: (rawArray) => ({ rawArray }),
            typescript: 'import("./model.js").ArrayValue',
          },
        }),
      });
      assert.equal(overridden.ok, true, JSON.stringify(overridden.diagnostics));
      assert.ok(
        !overridden.diagnostics.some(({ code }) => code === 'result-representation-unproven'),
      );
      await assert.rejects(
        checkQueries({ ...options, target, codecs, readTypes: { 23: 'string' } }),
        /already has a known representation/,
      );
    },
  );
});

test('declared codec representations must compile in the selected project', async () => {
  await sourceProject(
    { 'queries.ts': `${tag}\nexport const output = sql<{id: unknown}>\`SELECT 42 AS id\`;` },
    async (options) => {
      for (const typescript of ['MissingApplicationType', '() =>']) {
        await assert.rejects(
          checkQueries({
            ...options,
            codecs: defaultCodecs.with({
              oid: 23,
              text: { encode: String, decode: (value) => value, typescript },
            }),
          }),
          /Cannot resolve checker representation types/,
        );
      }
    },
  );
});

test('representation imports validate transitive type dependencies without selecting unrelated files', async () => {
  await sourceProject(
    {
      'queries.ts': `${tag}\nexport const output = sql<{id: unknown}>\`SELECT 42 AS id\`;`,
      'model.ts': 'export type {Value} from "./broken.js";',
      'broken.ts': 'export type Value = MissingApplicationType;',
      'unrelated.ts': 'export const invalid: number = "unrelated error";',
    },
    async (options, directory) => {
      const target = join(directory, 'queries.ts');
      const codecs = defaultCodecs.with({
        oid: 23,
        text: {
          encode: String,
          decode: (raw) => ({ raw }),
          typescript: 'import("./model.js").Value',
        },
      });
      await assert.rejects(
        checkQueries({ ...options, target, codecs }),
        /Cannot resolve checker representation types:.*MissingApplicationType/,
      );
      await writeFile(join(directory, 'broken.ts'), 'export interface Value { raw: string }');
      const report = await checkQueries({ ...options, target, codecs });
      assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
      assert.ok(!report.diagnostics.some(({ code }) => code === 'result-representation-unproven'));
      const ordinary = await checkQueries({ ...options, target });
      assert.equal(ordinary.ok, true, JSON.stringify(ordinary.diagnostics));
    },
  );
});

test('the checker resolves imported aliases, indexed types, Pick, unions and barrel exports without evaluating code', async () => {
  await sourceProject(
    {
      'model.ts': 'export interface Database { users: { row: { id: number; name: string } } }',
      'barrel.ts': "export { sql as query } from '@kequtech/tenon-orm';",
      'queries.ts': [
        "import {query as authored} from './barrel.js';",
        "import type {Database} from './model.js';",
        'throw new Error("Application source must never run");',
        "type Summary = Pick<Database['users']['row'], 'id' | 'name'>;",
        'declare const id: number;',
        "export const first = authored<Summary>`SELECT ${id}::integer AS id, 'Ada'::text AS name`;",
        'export const second = authored<{id: number} | {name: string}>`SELECT 1 AS id`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, true, JSON.stringify(errors(report)));
      assert.equal(report.queries.length, 2);
      assert.ok(report.queries.every(({ status }) => status === 'analysed'));
      assert.ok(report.diagnostics.some(({ code }) => code === 'nullability-unproven'));
    },
  );
});

test('result diagnostics identify missing columns, bigint contradictions and incompatible array elements', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        'export const missing = sql<{id: number; name: string}>`SELECT 1 AS id`;',
        'export const count = sql<{total: number}>`SELECT count(*) AS total FROM pg_class`;',
        'export const arrays = sql<{ids: readonly number[]}>`SELECT ARRAY[1::bigint] AS ids`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      const missing = report.diagnostics.find(({ code }) => code === 'missing-column')!;
      assert.equal(missing.resultColumn, 'name');
      const wrong = report.diagnostics.find(
        ({ code, resultColumn }) => code === 'result-type-mismatch' && resultColumn === 'total',
      )!;
      assert.equal(wrong.line, 3);
      assert.equal(wrong.observed, 'string');
      assert.equal(wrong.expected, 'number');
      assert.ok(
        report.diagnostics.some(
          ({ code, resultColumn }) => code === 'result-type-mismatch' && resultColumn === 'ids',
        ),
      );
    },
  );
});

test('a declared row with required fields contradicts a command with no result columns', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        'export const result = sql<{id: number}>`SET application_name TO tenon_check_test`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      assert.ok(
        report.diagnostics.some(
          ({ code, resultColumn }) => code === 'missing-column' && resultColumn === 'id',
        ),
      );
    },
  );
});

test('project emission roots do not exclude in-memory checker types and checking never emits files', async () => {
  await sourceProject(
    {
      'src/queries.ts': [tag, 'export const result = sql<{id: number}>`SELECT 1 AS id`;'].join(
        '\n',
      ),
    },
    async (options, directory) => {
      const config = JSON.parse(await readFile(options.project!, 'utf8')) as {
        compilerOptions: Record<string, unknown>;
        include: string[];
      };
      Object.assign(config.compilerOptions, {
        rootDir: 'src',
        outDir: 'build',
        noEmit: false,
        composite: true,
        declaration: true,
      });
      config.include = ['src/**/*.ts'];
      await writeFile(options.project!, JSON.stringify(config));
      const report = await checkQueries(options);
      assert.equal(report.ok, true, JSON.stringify(errors(report)));
      await assert.rejects(access(join(directory, 'build')), { code: 'ENOENT' });
      config.compilerOptions.strictNullChecks = false;
      await writeFile(options.project!, JSON.stringify(config));
      await assert.rejects(checkQueries(options), /strictNullChecks/);
    },
  );
});

test('file:line selects one complete multiline query and rejects missing or ambiguous targets', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        'export const valid =',
        '  sql<{id: number}>`',
        '    SELECT 1 AS id',
        '  `;',
        'export const invalid = sql<{id: string}>`SELECT 1 AS id`;',
        'const a = sql`SELECT 1`; const b = sql`SELECT 2`;',
      ].join('\n'),
    },
    async (options, directory) => {
      for (const line of [2, 3, 4, 5]) {
        const report = await checkQueries({
          ...options,
          target: join(directory, `queries.ts:${line}`),
        });
        assert.equal(report.ok, true, JSON.stringify(errors(report)));
        assert.equal(report.queries.length, 1);
      }
      assert.equal(
        (await checkQueries({ ...options, target: join(directory, 'queries.ts') })).ok,
        false,
      );
      assert.equal(
        (
          await checkQueries({ ...options, target: join(directory, 'queries.ts:1') })
        ).diagnostics.at(-1)!.code,
        'no-query-sites',
      );
      assert.equal(
        (
          await checkQueries({ ...options, target: join(directory, 'queries.ts:7') })
        ).diagnostics.at(-1)!.code,
        'ambiguous-query-target',
      );
    },
  );
});

test('fixed fragments, const aliases, identifiers, joins and ternaries describe every complete variant', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        'declare const descending: boolean;',
        'declare const id: number;',
        'const table = identifier("pg_catalog", "pg_class");',
        'const predicates = [sql.fragment`oid > ${id}::oid`, sql.fragment`relname <> ${""}`] as const;',
        'const condition = sql.fragment`(${sql.join(predicates, "AND")})`;',
        'const ordering = descending ? sql.fragment`DESC` : sql.fragment`ASC`;',
        'export const result = sql<{relname: string}>`SELECT relname FROM ${table} WHERE ${condition} ORDER BY relname ${ordering}`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, true, JSON.stringify(errors(report)));
      assert.equal(report.queries[0]!.variants, 2);
    },
  );
});

test('reusing a conditional fragment preserves branch correlation and result unions', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        'declare const choose: boolean;',
        "const value = choose ? sql.fragment`1::integer` : sql.fragment`'text'::text`;",
        'export const pair = sql<{a: number; b: number} | {a: string; b: string}>`SELECT ${value} AS a, ${value} AS b`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, true, JSON.stringify(errors(report)));
      assert.equal(report.queries[0]!.variants, 2);
    },
  );
});

test('opaque fragments and mutable joins remain unchecked while independent sites and known bad branches continue', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        "import type {SqlFragment} from '@kequtech/tenon-orm';",
        'declare function dynamic(): SqlFragment;',
        'declare const choose: boolean;',
        'const branch = choose ? sql.fragment`1::integer` : dynamic();',
        'export const partial = sql<{id: string}>`SELECT ${branch} AS id`;',
        'const mutable = [sql.fragment`true`]; mutable.push(sql.fragment`false`);',
        'export const opaque = sql`SELECT 1 WHERE ${sql.join(mutable, "AND")}`;',
        'export const independent = sql<{size: number}>`SELECT count(*) AS size FROM pg_class`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      assert.equal(report.queries.filter(({ status }) => status === 'unchecked').length, 2);
      assert.ok(report.diagnostics.some(({ code }) => code === 'dynamic-fragment'));
      assert.ok(report.diagnostics.some(({ code }) => code === 'mutable-array'));
      assert.equal(
        report.diagnostics.filter(({ code }) => code === 'result-type-mismatch').length,
        2,
      );
    },
  );
});

test('composition exceeding the fixed variant budget is unchecked', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        'declare const flags: boolean[];',
        ...Array.from(
          { length: 5 },
          (_, i) => `const p${i} = flags[${i}] ? sql.fragment\`true\` : sql.fragment\`false\`;`,
        ),
        'export const query = sql`SELECT 1 WHERE ${p0} AND ${p1} AND ${p2} AND ${p3} AND ${p4}`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      assert.equal(report.queries[0]!.variants, 0);
      assert.ok(report.diagnostics.some(({ code }) => code === 'variant-limit'));
    },
  );
});

test('required object shapes, fixed batches, selected columns and assignments use the runtime SQL shape without executing writes', async () => {
  await migrationProject(pool)(
    {
      '0001_users.up.sql':
        'CREATE TABLE users (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, active boolean NOT NULL); CREATE SEQUENCE probe;',
    },
    async (database) => {
      await migrate(database);
      await sourceProject(
        {
          'queries.ts': [
            tag,
            'type NewUser = {name: string; active: boolean};',
            'declare const input: NewUser;',
            'declare const second: NewUser;',
            `const table = identifier(${JSON.stringify(database.namespace)}, 'users');`,
            'export const insert = sql<{id: number}>`INSERT INTO ${table} ${sql.insertValues<NewUser>(input)} RETURNING id`;',
            'export const batch = sql<{id: number}>`INSERT INTO ${table} ${sql.insertValues<NewUser>([input, second], ["name", "active"])} RETURNING id`;',
            'export const update = sql<{id: number}>`UPDATE ${table} SET ${sql.assignments<NewUser>(input, ["name"])} RETURNING id`;',
            `export const sequence = sql<{value: string}>\`SELECT nextval('${database.namespace}.probe') AS value\`;`,
          ].join('\n'),
        },
        async (options) => {
          const report = await checkQueries({
            ...options,
            session: { searchPath: quote(database.namespace) },
          });
          assert.equal(report.ok, true, JSON.stringify(errors(report)));
          assert.equal(report.queries.length, 4);
          assert.equal(report.context!.searchPath, quote(database.namespace));
          assert.deepEqual(
            (await pool.queryClassic(`SELECT * FROM ${qualified(database.namespace, 'users')}`, []))
              .rows,
            [],
          );
          assert.equal(
            (
              await pool.queryClassic(
                `SELECT is_called FROM ${qualified(database.namespace, 'probe')}`,
                [],
              )
            ).rows[0]!.is_called,
            false,
          );
        },
      );
    },
  );
});

test('untyped, optional, open and dynamic object expansions never become guessed SQL', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        'type Shape = {name: string; active?: boolean};',
        'declare const input: Shape;',
        'declare const batch: {name: string}[];',
        'declare const dictionary: Record<string, string>;',
        'export const inferred = sql`INSERT INTO users ${sql.insertValues(input)}`;',
        'export const optional = sql`UPDATE users SET ${sql.assignments<Shape>(input)}`;',
        'export const dynamic = sql`INSERT INTO users ${sql.insertValues<{name: string}>(batch)}`;',
        'export const open = sql`INSERT INTO users ${sql.insertValues<Record<string, string>>(dictionary)}`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      assert.equal(report.queries.filter(({ status }) => status === 'unchecked').length, 4);
      assert.ok(report.queries.every(({ variants }) => variants === 0));
      for (const code of [
        'expansion-type-required',
        'optional-expansion',
        'dynamic-array',
        'expansion-shape-unresolved',
      ])
        assert.ok(report.diagnostics.some((issue) => issue.code === code));
    },
  );
});

test('parameter encoders, nullable hints, Date and bigint inputs follow pgclear', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        "import {param, json, builtin} from '@kequtech/tenon-orm';",
        'declare const flag: boolean | null;',
        'export const nullable = sql<{value: boolean | null}>`SELECT ${flag} AS value`;',
        'export const encoded = sql<{items: unknown; payload: unknown; big: string}>`SELECT ${param([1, 2], builtin.int4Array)} AS items, ${json({x: 1})} AS payload, ${param("9007199254740993", builtin.int8)} AS big`;',
        'export const integerText = unsafeSql<{id: string}>("SELECT $1::bigint AS id", ["42"]);',
        'export const date = sql<{value: string}>`SELECT ${new Date()}::text AS value`;',
        'declare const big: bigint | null;',
        'export const bigInput = sql<{value: string | null}>`SELECT ${big}::bigint AS value`;',
        'export const bigLiteral = sql<{value: string}>`SELECT ${9007199254740993n}::bigint AS value`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.queries.length, 6);
      assert.equal(report.queries[0]!.variants, 2);
      // A bare NULL parameter defaults to text; declaring boolean cannot cover that variant.
      assert.ok(report.queries[0]!.diagnostics.some(({ code }) => code === 'result-type-mismatch'));
      assert.ok(!report.queries[1]!.diagnostics.some(({ kind }) => kind === 'mismatch'));
      assert.ok(
        !report.queries[1]!.diagnostics.some(({ code }) => code === 'encoder-oid-unproven'),
      );
      assert.ok(!report.queries[2]!.diagnostics.some(({ kind }) => kind === 'mismatch'));
      for (const query of report.queries.slice(3)) {
        assert.equal(query.status, 'analysed');
        assert.ok(!query.diagnostics.some(({ kind }) => kind === 'mismatch'));
      }
    },
  );
});

test('Date, bigint and supported Temporal inputs use server inference rather than fixed OIDs', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        "import type {TemporalInput} from '@kequtech/pgclear';",
        'declare const instant: TemporalInput;',
        'declare const unsupported: {readonly [Symbol.toStringTag]: "Temporal.PlainYearMonth"; toString(): string};',
        'export const date = sql<{size: number}>`SELECT length(${new Date()}) AS size`;',
        'export const bigint = sql<{size: number}>`SELECT length(${9007199254740993n}) AS size`;',
        'export const temporal = sql<{size: number}>`SELECT length(${instant}) AS size`;',
        'export const rejected = sql`SELECT ${unsupported}::text AS value`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.queries.length, 4);
      for (const query of report.queries.slice(0, 3)) {
        assert.equal(query.variants, 1);
        assert.ok(!query.diagnostics.some(({ kind }) => kind === 'mismatch'));
      }
      assert.ok(
        report.queries[3]!.diagnostics.some(({ code }) => code === 'parameter-type-mismatch'),
      );
    },
  );
});

test('unknown inputs remain unchecked while declared Parameter values receive the benefit of the doubt', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        "import type {Parameter} from '@kequtech/pgclear';",
        'declare const unknown: unknown;',
        'declare const parameter: Parameter;',
        'export const first = sql`SELECT ${unknown} AS value`;',
        'export const second = sql<{value: number}>`SELECT ${parameter} AS value`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      assert.ok(report.diagnostics.some(({ code }) => code === 'parameter-type-unresolved'));
      assert.ok(
        report.diagnostics.some(
          ({ code, kind }) => code === 'encoder-oid-unproven' && kind === 'unproven',
        ),
      );
      assert.equal(report.queries[1]!.status, 'analysed');
      assert.ok(!report.queries[1]!.diagnostics.some(({ kind }) => kind === 'mismatch'));
    },
  );
});

test('narrow literals, JSON members and nullability stay unproven instead of becoming definite mismatches', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        'type Name = string & {readonly __brand: unique symbol};',
        'declare const name: Name;',
        'export const result = sql<{id: 42; payload: {name: string}; optional: string; name: Name}>`SELECT 42 AS id, \'{"name":42}\'::jsonb AS payload, NULL::text AS optional, ${name}::text AS name`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, true, JSON.stringify(errors(report)));
      for (const code of [
        'result-refinement-unproven',
        'result-representation-unproven',
        'nullability-unproven',
      ])
        assert.ok(report.diagnostics.some((issue) => issue.code === code));
    },
  );
});

test('declared Parameter fields in generated-style shapes are trusted without inventing encoder OIDs', async () => {
  await migrationProject(pool)(
    { '0001_items.up.sql': 'CREATE TABLE items (name text NOT NULL);' },
    async (database) => {
      await migrate(database);
      await sourceProject(
        {
          'queries.ts': [
            tag,
            "import type {Parameter} from '@kequtech/pgclear';",
            'type Input = {name: string | Parameter};',
            'declare const input: Input;',
            `const table = identifier(${JSON.stringify(database.namespace)}, 'items');`,
            'export const query = sql<{name: string}>`INSERT INTO ${table} ${sql.insertValues<Input>(input, ["name"])} RETURNING name`;',
          ].join('\n'),
        },
        async (options) => {
          const report = await checkQueries(options);
          assert.equal(report.ok, true, JSON.stringify(errors(report)));
          assert.ok(report.diagnostics.some(({ code }) => code === 'encoder-oid-unproven'));
          assert.deepEqual(
            (await pool.queryClassic(`SELECT * FROM ${qualified(database.namespace, 'items')}`, []))
              .rows,
            [],
          );
        },
      );
    },
  );
});

test('separate ternaries correlate read-only parameter guards and their negation', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        'export function query(choose: boolean) {',
        " const a = choose ? sql.fragment`1::integer` : sql.fragment`'text'::text`;",
        " const b = !choose ? sql.fragment`'text'::text` : sql.fragment`1::integer`;",
        ' return sql<{a: number; b: number} | {a: string; b: string}>`SELECT ${a} AS a, ${b} AS b`;',
        '}',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, true, JSON.stringify(errors(report)));
      assert.equal(report.queries[0]!.variants, 2);
    },
  );
});

test('escaped arrays and malformed helpers are unchecked and do not stop a valid independent site', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        'const parts = [sql.fragment`true`]; const escaped = {parts}; escaped.parts.push(sql.fragment`false`);',
        'export const mutable = sql`SELECT 1 WHERE ${sql.join(parts, "AND")}`;',
        'const blank = sql.fragment``;',
        'export const empty = sql`SELECT 1 ${blank}`;',
        'export const invalidIdentifier = sql`SELECT 1 AS ${identifier("")}`;',
        'export const emptyColumns = sql`INSERT INTO pg_class ${sql.insertValues<{}>({}, [])}`;',
        'export const valid = sql<{id: number}>`SELECT 1 AS id`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      assert.equal(report.queries.filter(({ status }) => status === 'unchecked').length, 4);
      assert.equal(report.queries.at(-1)!.variants, 1);
      assert.ok(report.diagnostics.some(({ code }) => code === 'mutable-array'));
      assert.ok(report.diagnostics.some(({ code }) => code === 'invalid-identifier'));
    },
  );
});

test('unresolved generic expansion keys and mutable encoder OIDs do not become false proofs', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        "import {param} from '@kequtech/pgclear';",
        'export function generic<T extends object>(input: T) { return sql`INSERT INTO pg_class ${sql.insertValues<Pick<T, keyof T>>(input)}`; }',
        'const codec = {oid: 23, text: {encode: String, decode: Number}}; codec.oid = 20;',
        'export const encoded = sql<{value: string}>`SELECT ${param(1, codec)} AS value`;',
        'export const unsafeNumber = sql`SELECT ${9007199254740992}::bigint AS value`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.queries[0]!.status, 'unchecked');
      assert.ok(report.diagnostics.some(({ code }) => code === 'expansion-shape-unresolved'));
      assert.ok(
        report.queries[1]!.diagnostics.some(
          ({ code, kind }) => code === 'encoder-oid-unproven' && kind === 'unproven',
        ),
      );
      assert.ok(!report.queries[1]!.diagnostics.some(({ kind }) => kind === 'mismatch'));
      assert.ok(
        report.queries[2]!.diagnostics.some(({ code }) => code === 'parameter-value-mismatch'),
      );
    },
  );
});

test('custom decoder representations need explicit application types and known codec mappings cannot be overridden', async () => {
  await sourceProject(
    {
      'model.ts':
        'export type Value = {raw: string}; throw new Error("Must not import the application");',
      'queries.ts': [
        tag,
        "import type {Value} from './model.js';",
        'export const result = sql<{id: Value}>`SELECT 42 AS id`;',
      ].join('\n'),
    },
    async (options) => {
      const codecs = defaultCodecs.with({
        oid: 23,
        text: { encode: String, decode: (raw) => ({ raw }) },
      });
      const unknown = await checkQueries({ ...options, codecs });
      assert.ok(unknown.diagnostics.some(({ code }) => code === 'result-representation-unproven'));
      const explicit = await checkQueries({
        ...options,
        codecs,
        readTypes: { 23: 'import("./model.js").Value' },
      });
      assert.equal(explicit.ok, true, JSON.stringify(errors(explicit)));
      assert.ok(
        !explicit.diagnostics.some(({ code }) => code === 'result-representation-unproven'),
      );
      const incompatible = await checkQueries({
        ...options,
        codecs,
        readTypes: { 23: '{raw: number}' },
      });
      assert.equal(incompatible.ok, false);
      assert.ok(
        incompatible.diagnostics.some(
          ({ code, resultColumn }) => code === 'result-type-mismatch' && resultColumn === 'id',
        ),
      );
      const raw = await checkQueries({
        ...options,
        codecs: defaultCodecs.with({ oid: 23, text: builtin.text.text! }),
      });
      assert.ok(raw.diagnostics.some(({ code }) => code === 'result-type-mismatch'));
      await assert.rejects(
        checkQueries({ ...options, readTypes: { 23: 'string' } }),
        /already has a known representation/,
      );
    },
  );
});

test('no sites, unrelated tags, TypeScript errors and PostgreSQL errors fail honestly while later sites continue', async () => {
  await sourceProject(
    {
      'unrelated.ts':
        'function sql(strings: TemplateStringsArray) { return strings[0] } export const x = sql`SELECT 1`;',
      'queries.ts': [
        tag,
        'const invalid: number = "not a number";',
        'export const bad = sql`SELECT absent FROM pg_class`;',
        'export const good = sql<{id: number}>`SELECT 1 AS id`;',
      ].join('\n'),
    },
    async (options, directory) => {
      const empty = await checkQueries({ ...options, target: join(directory, 'unrelated.ts') });
      assert.equal(empty.ok, false);
      assert.equal(empty.diagnostics.at(-1)!.code, 'no-query-sites');
      const report = await checkQueries({ ...options, target: join(directory, 'queries.ts') });
      assert.equal(report.ok, false);
      assert.ok(report.diagnostics.some(({ code }) => code === 'typescript-error'));
      assert.ok(report.diagnostics.some(({ code }) => code === '42703'));
      assert.equal(report.queries[1]!.variants, 1);
    },
  );
});

test('check CLI supports whole-file and line targeting, JSON reports, exit status and strict flag validation', async () => {
  await sourceProject(
    {
      'queries.ts': [
        tag,
        'export const good = sql<{id: number}>`SELECT 1 AS id`;',
        'export const bad = sql<{count: number}>`SELECT count(*) AS count FROM pg_class`;',
      ].join('\n'),
    },
    async (options, directory) => {
      const cli = resolve('dist/cli.js');
      const env = { ...process.env, DATABASE_URL: testConnection };
      const good = await run(
        process.execPath,
        [cli, 'check', join(directory, 'queries.ts:2'), '--project', options.project!, '--json'],
        { env },
      );
      assert.equal((JSON.parse(good.stdout) as CheckReport).ok, true);
      const text = await run(process.execPath, [cli, 'check', join(directory, 'queries.ts:2')], {
        env,
      });
      assert.match(text.stdout, /1 queries, 1 analysed, 0 unchecked/);
      await assert.rejects(
        run(process.execPath, [cli, 'check', '--project', options.project!, '--json'], { env }),
        (error: unknown) => {
          const failed = error as { code: number; stdout: string };
          assert.equal(failed.code, 1);
          assert.equal((JSON.parse(failed.stdout) as CheckReport).ok, false);
          return true;
        },
      );
      await assert.rejects(
        run(process.execPath, [cli, 'check', '--namespace', 'public'], { env }),
        (error: unknown) => {
          assert.match((error as { stderr: string }).stderr, /not supported by check/);
          return true;
        },
      );
    },
  );
});
