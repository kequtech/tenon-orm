import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool } from '@kequtech/pgclear';
import { checkQueries } from '../src/check.js';
import { errors, sourceProject } from './helpers/checker.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const pool = createPool(testConnection);
before(() => assertTestDatabase(pool));
after(() => pool.close());
const imports = "import { sql, param, builtin, type SqlFragment } from '@kequtech/tenon-orm';";

test('single-return helpers substitute scalar and fragment arguments across modules without executing code', async () => {
  await sourceProject(
    {
      'helpers.ts': [
        imports,
        'throw new Error("Never execute helpers");',
        'export function audience(viewerId: string) { return sql.fragment`(is_public OR owner_id = ${viewerId})`; }',
        'export const pair = (first: number, second: string) => sql.fragment`${second}::text AS second, ${first}::integer AS first, ${first}::integer AS again`;',
        'export const mixed = function (value: boolean, extra: SqlFragment) { return sql.fragment`${value} AS flag, ${extra} AS extra`; };',
        'export function encoded(value: import("@kequtech/tenon-orm").Parameter) { return sql.fragment`${value}`; }',
      ].join('\n'),
      'queries.ts': [
        imports,
        'import { audience, pair, mixed, encoded } from "./helpers.js";',
        "export function visible(viewerId: string) { return sql<{id: number}>`SELECT id FROM (VALUES (1, true, 'owner')) AS posts(id,is_public,owner_id) WHERE ${audience(viewerId)}`; }",
        'export const reordered = sql<{first: number; second: string; again: number}>`SELECT ${pair(1, "two")}`;',
        "export const values = sql<{flag: boolean; extra: string}>`SELECT ${mixed(true, sql.fragment`'hello'::text`)}`;",
        'export const hinted = sql<{value: number}>`SELECT ${encoded(param(1, builtin.int4))} AS value`;',
        'export const wrong = sql<{value: string}>`SELECT ${encoded(param(1, builtin.int4))} AS value`;',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.deepEqual(report.coverage, { total: 5, analysed: 5, unchecked: 0 });
      assert.equal(errors(report).length, 1, JSON.stringify(errors(report)));
      assert.equal(errors(report)[0]!.code, 'result-type-mismatch');
      assert.equal(report.queries.at(-1)!.diagnostics[0]!.observed, 'number');
    },
  );
});

test('local predicate lists recover ordered pushes, nested alternatives and stable guard correlations', async () => {
  await sourceProject(
    {
      'queries.ts': [
        imports,
        'throw new Error("Never execute queries");',
        'export function filtered(ownerId: string, status: string | undefined, choose: boolean) {',
        'const predicates = [sql.fragment`owner_id = ${ownerId}`];',
        'if (status) predicates.push(sql.fragment`status = ${status}`);',
        ...Array.from({ length: 5 }, () => 'if (Date.now() > 0) { Math.random(); }'),
        'if (choose) { predicates.push(sql.fragment`id > ${0}`, sql.fragment`id < ${100}`); }',
        'else { if (status) predicates.push(sql.fragment`id = ${1}`); }',
        "return sql<{id: number}>`SELECT id FROM (VALUES (1, 'owner', 'open')) AS posts(id,owner_id,status) WHERE ${sql.join(predicates, \"AND\")}`;",
        '}',
        'export function columns(choose: boolean) {',
        'const fields: SqlFragment[] = []; fields.push(sql.fragment`1 AS id`);',
        "if (choose) fields.push(sql.fragment`2::integer AS value`); else fields.push(sql.fragment`'text'::text AS value`);",
        'return sql<{id: number; value: number; other: number} | {id: number; value: string; other: string}>`SELECT ${sql.join(fields, ",")}, ${choose ? sql.fragment`3::integer` : sql.fragment`\'other\'::text`} AS other`;',
        '}',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, true, JSON.stringify(errors(report)));
      assert.deepEqual(
        report.queries.map(({ variants }) => variants),
        [4, 2],
      );
    },
  );
});

test('recoverable branches still expose SQL errors and result contradictions in predicate lists', async () => {
  await sourceProject(
    {
      'queries.ts': [
        imports,
        'declare function opaque(): SqlFragment;',
        'export function partial(choose: boolean) {',
        'const fields = [sql.fragment`1 AS id`];',
        'if (choose) fields.push(sql.fragment`2 AS value`); else fields.push(opaque());',
        'return sql<{id: number; value: string}>`SELECT ${sql.join(fields, ",")}`;',
        '}',
        'export function invalid(choose: boolean) {',
        'const predicates = [sql.fragment`true`];',
        'if (choose) predicates.push(sql.fragment`missing_column = 1`);',
        'return sql`SELECT 1 WHERE ${sql.join(predicates, "OR")}`;',
        '}',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.queries[0]!.status, 'unchecked');
      assert.equal(report.queries[0]!.variants, 1);
      assert.ok(report.queries[0]!.diagnostics.some(({ code }) => code === 'dynamic-fragment'));
      assert.ok(report.queries[0]!.diagnostics.some(({ code }) => code === 'result-type-mismatch'));
      assert.ok(report.queries[1]!.diagnostics.some(({ code }) => code === '42703'));
    },
  );
});

test('escaping, aliased, reordered or unrecognized list mutations remain unchecked', async () => {
  const operations = [
    'const alias = predicates; alias.push(sql.fragment`false`);',
    'consume(predicates);',
    'const escape = {predicates};',
    'function mutate() { predicates.push(sql.fragment`false`); } mutate();',
    'for (const value of [true]) predicates.push(sql.fragment`${value}`);',
    'predicates[0] = sql.fragment`false`;',
    'predicates.splice(0, 1);',
    'predicates.push(...[sql.fragment`false`]);',
    'const count = predicates.push(sql.fragment`false`);',
    'if (choose) return;',
  ];
  await sourceProject(
    Object.fromEntries(
      operations.map((operation, i) => [
        `case${i}.ts`,
        [
          imports,
          'declare function consume(value: unknown): void;',
          'export function query(choose: boolean) {',
          'const predicates = [sql.fragment`true`];',
          operation,
          'predicates.push(sql.fragment`true`);',
          'return sql`SELECT 1 WHERE ${sql.join(predicates, "AND")}`;',
          '}',
        ].join('\n'),
      ]),
    ),
    async (options) => {
      const report = await checkQueries({ ...options, connection: 'postgresql://unused' });
      assert.ok(report.queries.every(({ status }) => status === 'unchecked'));
      assert.ok(report.diagnostics.some(({ code }) => code === 'mutable-array'));
      assert.ok(!report.diagnostics.some(({ code }) => code === 'inspection-failed'));
    },
  );
});

test('list recovery retains variant limits, empty-join rejection and mutable guard restrictions', async () => {
  await sourceProject(
    {
      'queries.ts': [
        imports,
        'export function wide(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {',
        'const fields = [sql.fragment`1 AS id`];',
        ...['a', 'b', 'c', 'd', 'e'].map(
          (guard) => `if (${guard}) fields.push(sql.fragment\`1 AS ${guard}\`);`,
        ),
        'return sql`SELECT ${sql.join(fields, ",")}`;',
        '}',
        'export function empty(choose: boolean) {',
        'const fields: SqlFragment[] = []; if (choose) fields.push(sql.fragment`1`);',
        'return sql`SELECT ${sql.join(fields, ",")}`;',
        '}',
        'export function mutable(choose: boolean) {',
        'const fields = [sql.fragment`1 AS id`];',
        'if (choose) fields.push(sql.fragment`2 AS a`); choose = !choose;',
        'if (choose) fields.push(sql.fragment`3 AS b`);',
        'return sql`SELECT ${sql.join(fields, ",")}`;',
        '}',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries({ ...options, connection: 'postgresql://unused' });
      assert.deepEqual(
        report.queries.map((query) => query.diagnostics.at(-1)!.code),
        ['variant-limit', 'empty-join', 'branch-correlation-unresolved'],
      );
      assert.ok(!report.diagnostics.some(({ code }) => code === 'inspection-failed'));
    },
  );
});
