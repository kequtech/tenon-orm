import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkQueries } from '../src/check.js';
import { sourceProject, errors } from './helpers/checker.js';

test('finite identifier parameters, imported aliases and reused names retain their actual variants', async () => {
  await sourceProject(
    {
      'names.ts': 'export type Catalog = "pg_class" | "pg_namespace";',
      'queries.ts': `import {sql,identifier} from '@kequtech/tenon-orm';
      import type {Catalog} from './names.js';
      throw new Error('source must never execute');
      export function read(table: Catalog, column: 'oid'|'tableoid') {
        const alias=table;
        return sql<{value:string}>\`SELECT \${identifier(column)}::text AS value
          FROM \${identifier('pg_catalog',table)} AS \${identifier(alias)}\`;
      }`,
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, true, JSON.stringify(errors(report)));
      assert.equal(report.queries[0]!.variants, 4);
    },
  );
});

test('a contradiction in a permitted finite variant is reported', async () => {
  await sourceProject(
    {
      'queries.ts': `import {sql,identifier} from '@kequtech/tenon-orm';
    export function read(table:'pg_class'|'pg_namespace') {
      return sql<{value:number}>\`SELECT count(*) AS value FROM \${identifier('pg_catalog',table)}\`;
    }`,
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      assert.equal(report.queries[0]!.variants, 2);
      assert.ok(report.diagnostics.some((d) => d.code === 'result-type-mismatch'));
    },
  );
});

test('unresolved table/column pairing is unchecked rather than an invented SQL mismatch', async () => {
  await sourceProject(
    {
      'queries.ts': [
        "import {sql,identifier} from '@kequtech/tenon-orm';",
        "export function read(table:'pg_class'|'pg_namespace', column:'relname'|'nspname') {",
        'return sql<{value:string}>`SELECT ${identifier(column)}::text AS value FROM ${identifier("pg_catalog",table)}`;',
        '}',
      ].join('\n'),
    },
    async (options) => {
      const report = await checkQueries(options);
      assert.equal(report.ok, false);
      assert.equal(report.queries[0]!.status, 'unchecked');
      assert.equal(report.queries[0]!.variants, 2);
      assert.ok(report.diagnostics.some((d) => d.code === 'identifier-correlation-unresolved'));
      assert.equal(
        report.diagnostics.some((d) => d.kind === 'mismatch'),
        false,
      );
    },
  );
});

test('open, asserted, mutable, correlated and excessive choices stay unchecked before acquisition', async () => {
  await sourceProject(
    {
      'queries.ts': `import {sql,identifier} from '@kequtech/tenon-orm';
    export function open(name:string) {return sql\`SELECT * FROM \${identifier(name)}\`;}
    export function cast(name:string) {return sql\`SELECT * FROM \${identifier(name as 'pg_class')}\`;}
    export function mutable(name:'pg_class'|'pg_namespace') {name='pg_class';return sql\`SELECT * FROM \${identifier(name)}\`;}
    export function correlated(target:{table:'a';column:'x'}|{table:'b';column:'y'}) {
      return sql\`SELECT \${identifier(target.column)} FROM \${identifier(target.table)}\`;
    }
    export function wide(name:${Array.from({ length: 17 }, (_, i) => JSON.stringify('table' + i)).join('|')}) {
      return sql\`SELECT * FROM \${identifier(name)}\`;
    }
    export function invalid(name:''|'valid') {return sql\`SELECT * FROM \${identifier(name)}\`;}
  `,
    },
    async (options) => {
      const report = await checkQueries({ ...options, connection: 'postgresql://unused' });
      assert.deepEqual(report.coverage, { total: 6, analysed: 0, unchecked: 6 });
      assert.deepEqual(
        report.queries.map((q) => q.diagnostics.at(-1)!.code),
        [
          'dynamic-text',
          'dynamic-text',
          'dynamic-binding',
          'dynamic-text',
          'variant-limit',
          'invalid-identifier',
        ],
      );
    },
  );
});
