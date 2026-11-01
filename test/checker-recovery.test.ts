import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool } from '@kequtech/pgclear';
import { checkQueries } from '../src/check.js';
import { migrate } from '../src/index.js';
import { qualified } from '../src/sql.js';
import { errors, sourceProject } from './helpers/checker.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const pool = createPool(testConnection);
const project = migrationProject(pool);
const imports =
  "import { sql, unsafeSql, identifier, param, builtin, type SqlFragment, type QueryClient, type Database } from '@kequtech/tenon-orm';";
before(() => assertTestDatabase(pool));
after(() => pool.close());

test('literal query labels survive successful analysis, mismatches and every unchecked reporting path', async () => {
  await sourceProject(
    {
      'queries.ts': [
        imports,
        'throw new Error("Application source must never execute");',
        'declare function db(): Database; declare const tx: QueryClient;',
        'declare function opaque(): SqlFragment;',
        "db().query(((sql<{value: number}>`SELECT 1 AS value`)), {label: 'read', returns: 'one'});",
        'tx.query(unsafeSql<{value: number}>("SELECT 2 AS value", []), {"label": `raw`});',
        "tx.query(sql`SELECT 1 WHERE ${opaque()}`, {label: 'opaque'});",
        "export function external(text: string, values: readonly unknown[]) { return tx.query(unsafeSql(text, values), {label: 'external'}); }",
        "tx.query(sql<{value: string}>`SELECT 3 AS value`, {label: 'wrong'});",
        "tx.query(sql`SELECT no_such_column`, {label: 'sql-error'});",
      ].join('\n'),
    },
    async (options, directory) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      assert.deepEqual(report.coverage, { total: 6, analysed: 4, unchecked: 2 });
      assert.deepEqual(
        report.queries.map(({ label }) => label),
        ['read', 'raw', 'opaque', 'external', 'wrong', 'sql-error'],
      );
      assert.equal(report.queries[2]!.diagnostics[0]!.code, 'dynamic-fragment');
      assert.equal(report.queries[3]!.diagnostics[0]!.code, 'dynamic-text');
      assert.equal(report.queries[4]!.diagnostics[0]!.code, 'result-type-mismatch');
      assert.equal(report.queries[5]!.diagnostics[0]!.code, '42703');
      assert.ok(report.diagnostics.every((diagnostic) => !Object.hasOwn(diagnostic, 'label')));
      const onlyUnchecked = await checkQueries({
        ...options,
        connection: 'postgresql://unused',
        target: `${join(directory, 'queries.ts')}:8`,
      });
      assert.deepEqual(onlyUnchecked.coverage, { total: 1, analysed: 0, unchecked: 1 });
      assert.equal(onlyUnchecked.queries[0]!.label, 'external');
      const failedInspection = await checkQueries({
        ...options,
        connection: 'postgresql://postgres:postgres@127.0.0.1:1/tenon_orm_test',
      });
      assert.ok(failedInspection.queries.every(({ status }) => status === 'unchecked'));
      assert.deepEqual(
        failedInspection.queries.map(({ label }) => label),
        report.queries.map(({ label }) => label),
      );
      assert.ok(failedInspection.diagnostics.some(({ code }) => code === 'inspection-failed'));
    },
  );
});

test('unavailable or ambiguous labels and unrelated query methods do not acquire metadata', async () => {
  await sourceProject(
    {
      'queries.ts': [
        imports,
        'declare const tx: QueryClient; const label = "variable"; const options = {label}; const key = "label";',
        'tx.query(sql`SELECT 1`, {label});',
        'tx.query(sql`SELECT 1`, options);',
        'tx.query(sql`SELECT 1`, {label: "before", ...options});',
        'tx.query(sql`SELECT 1`, {...options, label: "after"});',
        'tx.query(sql`SELECT 1`, {[key]: "computed"});',
        'tx.query(sql`SELECT 1`, {get label() {return "accessor";}});',
        'tx.query(sql`SELECT 1`, {label: "duplicate", "label": "duplicate"});',
        'const stored = sql`SELECT 1`; tx.query(stored, {label: "later"});',
        'const fake = {query(statement: unknown, options: unknown) {}};',
        'fake.query(sql`SELECT 1`, {label: "unrelated"});',
        'tx.query((true ? sql`SELECT 1` : sql`SELECT 2`), {label: "ambiguous"});',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.queries.length, 11);
      assert.ok(report.queries.every((query) => !Object.hasOwn(query, 'label')));
      // The duplicate options property is a TypeScript error; metadata extraction does not conceal it.
      assert.ok(report.diagnostics.some(({ code }) => code === 'typescript-error'));
    },
  );
});

test('identifier alternatives quote each name and correlate components, columns and reused aliases', async () => {
  await project(
    {
      '0001_tables.up.sql':
        'CREATE TABLE "left""table" (left_value integer); CREATE TABLE "right.table" (right_value integer);',
    },
    async (database) => {
      await migrate(database);
      await sourceProject(
        {
          'queries.ts': [
            imports,
            'declare const choose: boolean;',
            'const table = choose ? \'left"table\' : "right.table"; const alias = table;',
            'const column = choose ? "left_value" : "right_value";',
            `const namespace = ${JSON.stringify(database.namespace)};`,
            'export const query = sql<{value: number}>`SELECT ${identifier(column)} AS value FROM ${identifier(namespace, alias)} WHERE ${identifier(alias, column)} > ${0}`;',
          ].join('\n'),
        },
        async (options) => {
          const report = await checkQueries(options);
          assert.equal(report.ok, true, JSON.stringify(errors(report)));
          assert.equal(report.queries[0]!.variants, 2);
          assert.deepEqual(report.diagnostics, []);
        },
      );
    },
  );
});

test('unrecoverable identifier branches remain unchecked while known contradictions are still reported', async () => {
  await sourceProject(
    {
      'queries.ts': [
        imports,
        'declare const choose: boolean; const runtime = String(Date.now());',
        'const table = choose ? "pg_class" : runtime;',
        'export const partial = sql<{value: number}>`SELECT count(*) AS value FROM ${identifier("pg_catalog", table)}`;',
        'export const invalid = sql`SELECT * FROM ${identifier("pg_catalog", choose ? "pg_class" : "")}`;',
        'export const raw = unsafeSql(choose ? "SELECT 1" : "SELECT 2", []);',
        'export function literalType(name: "pg_class" | "pg_namespace") { return sql`SELECT * FROM ${identifier("pg_catalog", name)}`; }',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      assert.deepEqual(report.coverage, { total: 4, analysed: 0, unchecked: 4 });
      assert.equal(report.queries[0]!.variants, 1);
      assert.ok(report.queries[0]!.diagnostics.some(({ code }) => code === 'dynamic-text'));
      assert.ok(report.queries[0]!.diagnostics.some(({ code }) => code === 'result-type-mismatch'));
      assert.ok(report.queries[1]!.diagnostics.some(({ code }) => code === 'invalid-identifier'));
      for (const query of report.queries.slice(2))
        assert.ok(query.diagnostics.some(({ code }) => code === 'dynamic-text'));
    },
  );
});

test('identifier alternatives retain the variant and depth bounds and reject mutable names', async () => {
  await sourceProject(
    {
      'queries.ts': [
        imports,
        'declare const a: boolean, b: boolean, c: boolean, d: boolean, e: boolean;',
        'export const wide = sql`SELECT 1 FROM ${identifier(a ? "a" : "b", b ? "a" : "b", c ? "a" : "b", d ? "a" : "b", e ? "a" : "b")}`;',
        'let name = "pg_class";',
        'export const mutable = sql`SELECT 1 FROM ${identifier("pg_catalog", name)}`;',
        ...Array.from(
          { length: 35 },
          (_, i) => `const name${i} = ${i ? `name${i - 1}` : '"pg_class"'};`,
        ),
        'export const deep = sql`SELECT 1 FROM ${identifier("pg_catalog", name34)}`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries({ ...options, connection: 'postgresql://unused' });
      assert.equal(report.ok, false);
      assert.deepEqual(
        report.queries.map((query) => query.diagnostics.at(-1)!.code),
        ['variant-limit', 'dynamic-binding', 'composition-depth'],
      );
      assert.ok(!report.diagnostics.some(({ code }) => code === 'inspection-failed'));
    },
  );
});

test('a shared fragment factory checks both column expressions and bound values without executing source', async () => {
  await project(
    {
      '0001_images.up.sql': 'CREATE TABLE images (id uuid); CREATE TABLE scenarios (image jsonb);',
    },
    async (database) => {
      await migrate(database);
      await sourceProject(
        {
          'predicates.ts': `${imports}\nthrow new Error("Do not execute helper modules");\nexport const unused = (id: SqlFragment) => sql.fragment\`NOT EXISTS (SELECT 1 FROM ${qualified(database.namespace, 'scenarios')} WHERE image->>'imageId' = \${id} OR image->>'otherId' = \${id})\`;`,
          'queries.ts': [
            imports,
            'import {unused} from "./predicates.js";',
            'declare const id: string;',
            `export const candidates = sql<{id: string}>\`SELECT id FROM ${qualified(database.namespace, 'images')} WHERE \${unused(sql.fragment\`images.id::text\`)}\`;`,
            `export const recheck = sql<{id: string}>\`SELECT id FROM ${qualified(database.namespace, 'images')} WHERE \${unused(sql.fragment\`\${id}::text\`)}\`;`,
          ].join('\n'),
        },
        async (options) => {
          const report = await checkQueries(options);
          assert.equal(report.ok, true, JSON.stringify(errors(report)));
          assert.deepEqual(report.coverage, { total: 2, analysed: 2, unchecked: 0 });
          assert.deepEqual(report.diagnostics, []);
          assert.deepEqual(
            (await pool.queryClassic(`SELECT * FROM ${qualified(database.namespace, 'images')}`))
              .rows,
            [],
          );
        },
      );
    },
  );
});

test('factory substitution preserves argument order, repeated parameters and separate call bindings', async () => {
  await sourceProject(
    {
      'queries.ts': [
        imports,
        'const project = (left: SqlFragment, right: SqlFragment) => sql.fragment`${right} AS second, ${left} AS first, ${left} AS again`;',
        'const repeat = (value: SqlFragment) => sql.fragment`COALESCE(${value}, ${value})`;',
        'export const reordered = sql<{first: number; second: string; again: number; tail: boolean}>`SELECT ${project(sql.fragment`${param(1, builtin.int4)}`, sql.fragment`${param("two", builtin.text)}`)}, ${true} AS tail`;',
        'export const separate = sql<{a: number; b: string}>`SELECT ${repeat(sql.fragment`${param(1, builtin.int4)}`)} AS a, ${repeat(sql.fragment`${param("two", builtin.text)}`)} AS b`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, true, JSON.stringify(errors(report)));
      assert.deepEqual(
        report.queries.map(({ variants }) => variants),
        [1, 1],
      );
      assert.deepEqual(report.diagnostics, []);
    },
  );
});

test('factory arguments retain correlated branches within a call and independent branches across calls', async () => {
  await sourceProject(
    {
      'queries.ts': [
        imports,
        'declare const a: boolean, b: boolean;',
        'const pair = (value: SqlFragment) => sql.fragment`${value} AS first, ${value} AS second`;',
        'const repeat = (value: SqlFragment) => sql.fragment`COALESCE(${value}, ${value})`;',
        "export const correlated = sql<{first: number; second: number} | {first: string; second: string}>`SELECT ${pair(a ? sql.fragment`1::integer` : sql.fragment`'text'::text`)}`;",
        "export const independent = sql<{first: number | string; second: number | string}>`SELECT ${repeat(a ? sql.fragment`1::integer` : sql.fragment`'a'::text`)} AS first, ${repeat(b ? sql.fragment`2::integer` : sql.fragment`'b'::text`)} AS second`;",
        'declare function opaque(): SqlFragment;',
        'export const partial = sql<{first: string; second: string}>`SELECT ${pair(a ? sql.fragment`1::integer` : opaque())}`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      assert.deepEqual(report.coverage, { total: 3, analysed: 2, unchecked: 1 });
      assert.deepEqual(
        report.queries.map(({ variants }) => variants),
        [2, 4, 1],
      );
      assert.ok(report.queries[2]!.diagnostics.some(({ code }) => code === 'dynamic-fragment'));
      assert.equal(
        report.queries[2]!.diagnostics.filter(({ code }) => code === 'result-type-mismatch').length,
        2,
      );
    },
  );
});

test('factory support stays bounded to const arrow templates interpolating fragment parameters', async () => {
  const functions = [
    'const f = (value: SqlFragment) => { return sql.fragment`${value}`; };',
    'const f = (value: SqlFragment = sql.fragment`1`) => sql.fragment`${value}`;',
    'const f = (value?: SqlFragment) => sql.fragment`${value}`;',
    'const f = (...values: SqlFragment[]) => sql.fragment`${values[0]}`;',
    'let f = (value: SqlFragment) => sql.fragment`${value}`;',
    'const f = <T extends SqlFragment>(value: T) => sql.fragment`${value}`;',
    'const f = (value: SqlFragment): SqlFragment => sql.fragment`${f(value)}`;',
    'const captured = sql.fragment`1`; const f = (value: SqlFragment) => sql.fragment`${captured} ${value}`;',
    'const f = (value: SqlFragment) => sql.fragment`${true ? value : sql.fragment`1`}`;',
    'const f = (value: SqlFragment) => sql.fragment`${(() => value)()}`;',
  ];
  await sourceProject(
    Object.fromEntries(
      functions.map((fn, index) => [
        `case${index}.ts`,
        `${imports}\n${fn}\nexport const query = sql\`SELECT \${f(sql.fragment\`1\`)}\`;`,
      ]),
    ),
    async (options) => {
      const report = await checkQueries({ ...options, connection: 'postgresql://unused' });
      assert.equal(report.ok, false);
      assert.deepEqual(report.coverage, {
        total: functions.length,
        analysed: 0,
        unchecked: functions.length,
      });
      assert.ok(
        report.queries.every((query) =>
          query.diagnostics.some(({ code }) => code === 'dynamic-fragment'),
        ),
      );
      assert.ok(!report.diagnostics.some(({ code }) => code === 'inspection-failed'));
    },
  );
});

test('factory expansion retains variant/depth limits and runtime rejection of empty fragments', async () => {
  const nested = 'repeat('.repeat(35) + 'sql.fragment`1`' + ')'.repeat(35);
  await sourceProject(
    {
      'queries.ts': [
        imports,
        'declare const a: boolean, b: boolean, c: boolean, d: boolean, e: boolean;',
        'const fields = (a: SqlFragment, b: SqlFragment, c: SqlFragment, d: SqlFragment, e: SqlFragment) => sql.fragment`${a}, ${b}, ${c}, ${d}, ${e}`;',
        'const repeat = (value: SqlFragment) => sql.fragment`${value}`;',
        'export const wide = sql`SELECT ${fields(a ? sql.fragment`1` : sql.fragment`2`, b ? sql.fragment`1` : sql.fragment`2`, c ? sql.fragment`1` : sql.fragment`2`, d ? sql.fragment`1` : sql.fragment`2`, e ? sql.fragment`1` : sql.fragment`2`)}`;',
        `export const deep = sql\`SELECT \${${nested}}\`;`,
        'const empty = () => sql.fragment` `;',
        'export const rejected = sql`SELECT ${empty()}`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries({ ...options, connection: 'postgresql://unused' });
      assert.equal(report.ok, false);
      assert.deepEqual(
        report.queries.map((query) => query.diagnostics.at(-1)!.code),
        ['variant-limit', 'composition-depth', 'empty-fragment'],
      );
      assert.ok(!report.diagnostics.some(({ code }) => code === 'inspection-failed'));
    },
  );
});
