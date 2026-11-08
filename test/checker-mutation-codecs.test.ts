import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool } from '@kequtech/pgclear';
import { checkQueries } from '../src/check.js';
import { migrate } from '../src/index.js';
import { errors, sourceProject } from './helpers/checker.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const pool = createPool(testConnection);
before(() => assertTestDatabase(pool));
after(() => pool.close());
const imports =
  "import { sql, identifier, builtin, type Codec, type MutationCodecs } from '@kequtech/tenon-orm';";

test('checking recovers shared field codecs for inserts, batches and optional patches without executing code', async () => {
  await migrationProject(pool)(
    {
      '0001_records.up.sql':
        'CREATE TABLE records (id integer PRIMARY KEY, payload jsonb, tags text[]);',
    },
    async (database) => {
      await migrate(database);
      await sourceProject(
        {
          'codecs.ts': `${imports}
        export type Input = { id: number; payload?: {enabled: boolean} | null; tags?: readonly string[] | null };
        export const codecs = {payload: builtin.jsonb, tags: builtin.textArray} satisfies MutationCodecs<Input>;`,
          'queries.ts': `${imports}
        import {codecs, type Input} from './codecs.js';
        throw new Error('Application source must never execute');
        const table = identifier(${JSON.stringify(database.namespace)}, 'records');
        export function insert(input: Input) {
          return sql<{id: number}>\`INSERT INTO \${table} \${sql.insertValues<Input>(input, ['id', 'payload', 'tags'], codecs)} RETURNING id\`;
        }
        export function update(input: Input) {
          return sql<{id: number}>\`UPDATE \${table} SET \${sql.assignments<Input>(input, ['payload', 'tags'], codecs)} WHERE id = \${input.id} RETURNING id\`;
        }
        export const batch = sql<{id: number}>\`INSERT INTO \${table} \${sql.insertValues<Input>([{id: 1, payload: {enabled: true}, tags: ['a']}, {id: 2, payload: null}], ['id', 'payload', 'tags'], codecs)} RETURNING id\`;
        export const inferred = sql<{id: number}>\`UPDATE \${table} SET \${sql.assignments<Input>({id: 1, tags: []}, undefined, {tags: builtin.textArray})} RETURNING id\`;
      `,
        },
        async (options) => {
          const report = await checkQueries(options);
          assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
          assert.deepEqual(report.coverage, { total: 4, analysed: 4, unchecked: 0 });
          assert.deepEqual(errors(report), []);
          assert.ok(report.diagnostics.every(({ code }) => code === 'empty-expansion-rejected'));
        },
      );
    },
  );
});

test('checking preserves unknown codec diagnostics and catches incompatible encoded SQL', async () => {
  await migrationProject(pool)(
    {
      '0001_records.up.sql': 'CREATE TABLE records (id integer PRIMARY KEY, tags text[]);',
    },
    async (database) => {
      await migrate(database);
      await sourceProject(
        {
          'queries.ts': `${imports}
        const table = identifier(${JSON.stringify(database.namespace)}, 'records');
        declare const opaque: Codec<readonly string[]>;
        export const unknown = sql<{id: number}>\`UPDATE \${table} SET \${sql.assignments<{tags: readonly string[]}>({tags: ['a']}, ['tags'], {tags: opaque})} RETURNING id\`;
        export const wrong = sql<{id: number}>\`UPDATE \${table} SET \${sql.assignments<{id: readonly string[]}>({id: ['a']}, ['id'], {id: builtin.textArray})} RETURNING id\`;
        export const raw = sql<{id: number}>\`UPDATE \${table} SET \${sql.assignments<{tags: readonly string[]}>({tags: ['a']}, ['tags'])} RETURNING id\`;
      `,
        },
        async (options) => {
          const report = await checkQueries(options);
          assert.equal(report.ok, false);
          assert.deepEqual(report.coverage, { total: 3, analysed: 3, unchecked: 0 });
          assert.ok(
            report.queries[0]!.diagnostics.some(
              ({ code, kind }) => code === 'encoder-oid-unproven' && kind === 'unproven',
            ),
          );
          assert.ok(report.queries[1]!.diagnostics.some(({ kind }) => kind === 'mismatch'));
          assert.ok(
            report.queries[2]!.diagnostics.some(({ code }) => code === 'parameter-type-mismatch'),
          );
        },
      );
    },
  );
});

test('mutable, escaped, computed and opaque field codec maps remain explicitly unchecked', async () => {
  for (const [setup, map, code] of [
    [
      'const codecs = {tags: builtin.textArray}; codecs.tags = builtin.textArray;',
      'codecs',
      'mutable-mutation-codecs',
    ],
    [
      'const codecs = {tags: builtin.textArray}; declare function escape(value: unknown): void; escape(codecs);',
      'codecs',
      'mutable-mutation-codecs',
    ],
    ['const codecs = {tags: builtin.textArray};', '{...codecs}', 'dynamic-mutation-codecs'],
    ['', "{['tags']: builtin.textArray}", 'dynamic-mutation-codecs'],
    [
      'declare function codecs(): MutationCodecs<{tags: string[]}>;',
      'codecs()',
      'dynamic-mutation-codecs',
    ],
  ]) {
    await sourceProject(
      {
        'queries.ts': `${imports}
        ${setup}
        export const query = sql<{id: number}>\`UPDATE records SET \${sql.assignments<{tags: string[]}>({tags: ['a']}, ['tags'], ${map})} RETURNING id\`;`,
      },
      async (options) => {
        const report = await checkQueries({ ...options, connection: 'postgresql://unused' });
        assert.deepEqual(report.coverage, { total: 1, analysed: 0, unchecked: 1 });
        assert.ok(
          errors(report).some((diagnostic) => diagnostic.code === code),
          JSON.stringify(report.diagnostics),
        );
      },
    );
  }
});
