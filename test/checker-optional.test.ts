import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool } from '@kequtech/pgclear';
import { checkQueries } from '../src/check.js';
import { createTenon, identifier, migrate, sql } from '../src/index.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';
import { errors, sourceProject } from './helpers/checker.js';

const pool = createPool(testConnection);
const project = migrationProject(pool);
const tag = "import { sql, identifier, type SqlFragment } from '@kequtech/tenon-orm';";
before(() => assertTestDatabase(pool));
after(() => pool.close());

test('optional insert fields produce bounded DEFAULT and omitted-column variants without binding undefined', async () => {
  await project(
    {
      '0001_records.up.sql': `CREATE TABLE records (
        name text NOT NULL DEFAULT 'default', active boolean DEFAULT true
      );`,
    },
    async (database) => {
      await migrate(database);
      await sourceProject(
        {
          'queries.ts': [
            tag,
            'throw new Error("Checker source must not execute");',
            'type Input = {name?: string | undefined; active?: boolean | null | undefined};',
            'declare const input: Input;',
            `const table = identifier(${JSON.stringify(database.namespace)}, 'records');`,
            'export const explicit = sql<{name: string; active: boolean | null}>`INSERT INTO ${table} ${sql.insertValues<Input>(input, ["name", "active"])} RETURNING name, active`;',
            'export const implicit = sql<{name: string; active: boolean | null}>`INSERT INTO ${table} ${sql.insertValues<Input>(input)} RETURNING name, active`;',
          ].join('\n'),
        },
        async (options) => {
          const report = await checkQueries(options);
          assert.equal(report.ok, true, JSON.stringify(errors(report)));
          assert.deepEqual(report.coverage, { total: 2, analysed: 2, unchecked: 0 });
          assert.deepEqual(
            report.queries.map(({ variants }) => variants),
            [6, 6],
          );
          assert.deepEqual(
            (await pool.queryClassic(`SELECT * FROM "${database.namespace}".records`)).rows,
            [],
          );

          const db = createTenon({ connection: pool });
          try {
            type Input = { name?: string | undefined; active?: boolean | null | undefined };
            for (const input of [
              {},
              { name: 'one' },
              { active: false },
              { active: null },
              { name: 'two', active: undefined },
            ] satisfies Input[]) {
              for (const columns of [undefined, ['name', 'active'] as const]) {
                const row = await db.query(
                  sql`INSERT INTO ${identifier(database.namespace, 'records')}
                    ${sql.insertValues<Input>(input, columns)} RETURNING name, active`,
                  { returns: 'one' },
                );
                assert.deepEqual(row, {
                  name: input.name ?? 'default',
                  active: input.active === undefined ? true : input.active,
                });
              }
            }
          } finally {
            await db.close();
          }
        },
      );
    },
  );
});

test('optional assignments omit fields, retain later parameters and report runtime rejection of empty patches', async () => {
  await project(
    {
      '0001_records.up.sql': `CREATE TABLE records (id integer PRIMARY KEY, name text, active boolean);
        INSERT INTO records VALUES (1, 'original', true);`,
    },
    async (database) => {
      await migrate(database);
      await sourceProject(
        {
          'queries.ts': [
            tag,
            'type Patch = {name?: string | undefined; active?: boolean | undefined};',
            'declare const patch: Patch;',
            'declare const id: number;',
            `const table = identifier(${JSON.stringify(database.namespace)}, 'records');`,
            'export const update = sql<{id: number; name: string; active: boolean}>`UPDATE ${table} SET ${sql.assignments<Patch>(patch, ["name", "active"])} WHERE id = ${id} RETURNING id, name, active`;',
          ].join('\n'),
        },
        async (options) => {
          const report = await checkQueries(options);
          assert.equal(report.ok, true, JSON.stringify(errors(report)));
          assert.equal(report.queries[0]!.variants, 3);
          assert.ok(report.diagnostics.some(({ code }) => code === 'empty-expansion-rejected'));
          const db = createTenon({ connection: pool });
          type Patch = { name?: string | undefined; active?: boolean | undefined };
          try {
            for (const patch of [
              { name: 'changed' },
              { active: false, name: undefined },
              { name: 'last', active: true },
            ] satisfies Patch[]) {
              const row = await db.query(
                sql`UPDATE ${identifier(database.namespace, 'records')}
                  SET ${sql.assignments<Patch>(patch, ['name', 'active'])}
                  WHERE id = ${1} RETURNING id, name, active`,
                { returns: 'one' },
              );
              assert.equal(row.id, 1);
              if (patch.name !== undefined) assert.equal(row.name, patch.name);
              if (patch.active !== undefined) assert.equal(row.active, patch.active);
            }
            assert.throws(
              () => sql.assignments<Patch>({ name: undefined }, ['name', 'active']),
              /at least one defined field/,
            );
          } finally {
            await db.close();
          }
        },
      );
    },
  );
});

test('fixed optional batches use per-row defaults and first-seen inferred column order', async () => {
  await project(
    {
      '0001_records.up.sql':
        "CREATE TABLE records (flag boolean DEFAULT false, label text DEFAULT 'default');",
    },
    async (database) => {
      await migrate(database);
      await sourceProject(
        {
          'queries.ts': [
            tag,
            'type Input = {flag?: boolean; label?: string};',
            'declare const left: Input, right: Input;',
            `const table = identifier(${JSON.stringify(database.namespace)}, 'records');`,
            'export const implicit = sql`INSERT INTO ${table} ${sql.insertValues<Input>([left, right])}`;',
            'export const explicit = sql`INSERT INTO ${table} ${sql.insertValues<Input>([left, right], ["flag", "label"])}`;',
          ].join('\n'),
        },
        async (options) => {
          const report = await checkQueries(options);
          assert.equal(report.ok, true, JSON.stringify(errors(report)));
          assert.deepEqual(
            report.queries.map(({ variants }) => variants),
            [15, 16],
          );
          const db = createTenon({ connection: pool });
          type Input = { flag?: boolean; label?: string };
          try {
            assert.deepEqual(
              await db.query(
                sql`INSERT INTO ${identifier(database.namespace, 'records')}
                ${sql.insertValues<Input>([{ label: 'first' }, { flag: true }])} RETURNING flag, label`,
                { returns: 'many' },
              ),
              [
                { flag: false, label: 'first' },
                { flag: true, label: 'default' },
              ],
            );
            assert.deepEqual(
              await db.query(
                sql`INSERT INTO ${identifier(database.namespace, 'records')}
                ${sql.insertValues<Input>([{}, {}], ['flag', 'label'])} RETURNING flag, label`,
                { returns: 'many' },
              ),
              [
                { flag: false, label: 'default' },
                { flag: false, label: 'default' },
              ],
            );
            assert.throws(
              () => sql.insertValues<Input>([{}, {}]),
              /Default-only inserts require exactly one row/,
            );
          } finally {
            await db.close();
          }
        },
      );
    },
  );
});

test('undefined-only and never fields do not become binds; always-empty and excessive mutations remain unchecked', async () => {
  await project(
    {
      '0001_records.up.sql':
        "CREATE TABLE records (id integer GENERATED ALWAYS AS IDENTITY, name text DEFAULT 'default');",
    },
    async (database) => {
      await migrate(database);
      await sourceProject(
        {
          'models.ts':
            "import type { Parameter } from '@kequtech/tenon-orm'; export type Database = { records: { insert: { id?: never; name?: string | Parameter | undefined } } };",
          'queries.ts': [
            tag,
            "type Input = import('./models.js').Database['records']['insert'];",
            'declare const input: Input;',
            'declare const empty: {name?: undefined};',
            'type Wide = {a?: string; b?: string; c?: string; d?: string; e?: string};',
            'declare const wide: Wide;',
            `const table = identifier(${JSON.stringify(database.namespace)}, 'records');`,
            'export const insert = sql`INSERT INTO ${table} ${sql.insertValues<Input>(input, ["id", "name"])}`;',
            'export const none = sql`UPDATE ${table} SET ${sql.assignments<{name?: undefined}>(empty)}`;',
            'export const excessive = sql`UPDATE ${table} SET ${sql.assignments<Wide>(wide)}`;',
          ].join('\n'),
        },
        async (options) => {
          const report = await checkQueries(options);
          assert.equal(report.ok, false);
          assert.deepEqual(report.coverage, { total: 3, analysed: 1, unchecked: 2 });
          assert.deepEqual(
            report.queries.map(({ variants }) => variants),
            [2, 0, 0],
          );
          assert.ok(report.diagnostics.some(({ code }) => code === 'empty-expansion'));
          assert.ok(report.diagnostics.some(({ code }) => code === 'variant-limit'));
          assert.ok(!report.diagnostics.some(({ code }) => code === 'parameter-type-mismatch'));
        },
      );
    },
  );
});

test('coverage retains unchecked and partially recovered sites independently of mismatches and target selection', async () => {
  await sourceProject(
    {
      'good.ts': `${tag}\nexport const good = sql<{id: number}>\`SELECT 1 AS id\`;`,
      'mismatch.ts': `${tag}\nexport const bad = sql<{missing: number}>\`SELECT 1 AS id\`;`,
      'dynamic.ts': `${tag}\ndeclare function fragment(): SqlFragment; export const dynamic = sql\`SELECT \${fragment()} AS id\`;`,
      'partial.ts': `${tag}\ndeclare const flag: boolean; declare function fragment(): SqlFragment;\nconst choice = flag ? sql.fragment\`1\` : fragment();\nexport const partial = sql\`SELECT \${choice} AS id\`;`,
      'empty.ts': 'export const ordinary = 1;',
      'ambiguous.ts': `${tag}\nexport const first = sql\`SELECT 1\`; export const second = sql\`SELECT 2\`;`,
    },
    async (options, directory) => {
      const all = await checkQueries(options);
      assert.equal(all.ok, false);
      assert.deepEqual(all.coverage, { total: 6, analysed: 4, unchecked: 2 });
      const partial = all.queries.find(({ file }) => file.endsWith('partial.ts'))!;
      assert.equal(partial.status, 'unchecked');
      assert.equal(partial.variants, 1);
      const selected = await checkQueries({ ...options, target: join(directory, 'good.ts') });
      assert.equal(selected.ok, true);
      assert.deepEqual(selected.coverage, { total: 1, analysed: 1, unchecked: 0 });
      const empty = await checkQueries({ ...options, target: join(directory, 'empty.ts') });
      assert.equal(empty.ok, false);
      assert.deepEqual(empty.coverage, { total: 0, analysed: 0, unchecked: 0 });
      const ambiguous = await checkQueries({
        ...options,
        target: join(directory, 'ambiguous.ts') + ':2',
      });
      assert.equal(ambiguous.ok, false);
      assert.deepEqual(ambiguous.coverage, { total: 2, analysed: 0, unchecked: 2 });
    },
  );
});

test('constrained generic fields retain DEFAULT variants while empty and unconstrained mutations fail closed', async () => {
  await project(
    {
      '0001_records.up.sql':
        "CREATE TABLE records (value text DEFAULT 'default', required integer NOT NULL);",
    },
    async (database) => {
      await migrate(database);
      const table = `const table = identifier(${JSON.stringify(database.namespace)}, 'records');`;
      await sourceProject(
        {
          'optional.ts': [
            tag,
            table,
            'export function insert<T extends string | undefined>(input: {value: T; required: number}) {',
            'return sql`INSERT INTO ${table} ${sql.insertValues<{value: T; required: number}>(input, ["value", "required"])}`;',
            '}',
          ].join('\n'),
          'undefined.ts': [
            tag,
            table,
            'export function insert<T extends undefined>(input: {value: T; required: number}) {',
            'return sql`INSERT INTO ${table} ${sql.insertValues<{value: T; required: number}>(input, ["value", "required"])}`;',
            '}',
          ].join('\n'),
          'empty.ts': [
            tag,
            table,
            'export function update<T extends undefined>(input: {value: T}) {',
            'return sql`UPDATE ${table} SET ${sql.assignments<{value: T}>(input, ["value"])}`;',
            '}',
          ].join('\n'),
          'unconstrained.ts': [
            tag,
            table,
            'export function insert<T>(input: {value: T; required: number}) {',
            'return sql`INSERT INTO ${table} ${sql.insertValues<{value: T; required: number}>(input, ["value", "required"])}`;',
            '}',
          ].join('\n'),
        },
        async (options, directory) => {
          for (const [target, variants] of [
            ['optional.ts', 2],
            ['undefined.ts', 1],
          ] as const) {
            const report = await checkQueries({ ...options, target: join(directory, target) });
            assert.equal(report.ok, true, JSON.stringify(errors(report)));
            assert.deepEqual(report.coverage, { total: 1, analysed: 1, unchecked: 0 });
            assert.equal(report.queries[0]!.variants, variants);
          }
          for (const [target, code] of [
            ['empty.ts', 'empty-expansion'],
            ['unconstrained.ts', 'parameter-type-unresolved'],
          ] as const) {
            const report = await checkQueries({
              ...options,
              connection: 'postgresql://unused',
              target: join(directory, target),
            });
            assert.equal(report.ok, false);
            assert.deepEqual(report.coverage, { total: 1, analysed: 0, unchecked: 1 });
            assert.ok(
              report.diagnostics.some(
                (diagnostic) => diagnostic.kind === 'unchecked' && diagnostic.code === code,
              ),
            );
          }
          const db = createTenon({ connection: pool });
          try {
            async function insert<T extends string | undefined>(value: T, required: number) {
              return db.query(
                sql`INSERT INTO ${identifier(database.namespace, 'records')}
                ${sql.insertValues<{ value: T; required: number }>({ value, required }, ['value', 'required'])}
                RETURNING value, required`,
                { returns: 'one' },
              );
            }
            assert.deepEqual(await insert(undefined, 1), { value: 'default', required: 1 });
            assert.deepEqual(await insert('chosen', 2), { value: 'chosen', required: 2 });
          } finally {
            await db.close();
          }
        },
      );
    },
  );
});
