import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { builtin, createPool, defaultCodecs } from '@kequtech/pgclear';
import { checkQueries } from '../src/check.js';
import { describeQuery, migrate } from '../src/index.js';
import { qualified } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const pool = createPool(testConnection);
const project = migrationProject(pool);
const run = promisify(execFile);
before(() => assertTestDatabase(pool));
after(() => pool.close());

const schema = `CREATE TYPE state AS ENUM ('queued', 'done');
  CREATE DOMAIN wrapped_state AS state;
  CREATE TABLE records (
    state state NOT NULL, optional state, wrapped wrapped_state NOT NULL,
    states state[], at timestamptz NOT NULL
  );
  INSERT INTO records VALUES ('queued', NULL, 'done', ARRAY['queued', 'done']::state[],
    TIMESTAMPTZ '2026-11-01 12:34:56.123+00');`;

test('inspection preserves enum output labels under unrelated codecs and follows domain wire OIDs', async () => {
  await project({ '0001_enum.up.sql': schema }, async (options) => {
    await migrate(options);
    const table = qualified(options.namespace, 'records');
    const wrapped = qualified(options.namespace, 'wrapped_state');
    const state = qualified(options.namespace, 'state');
    const query = `SELECT state, optional, wrapped, states, at FROM ${table} WHERE state=$1::${wrapped}::${state}`;
    for (const [codecs, at] of [
      [defaultCodecs, '2026-11-01 12:34:56.123+00'],
      [defaultCodecs.with(builtin.timestamptzDate), new Date('2026-11-01T12:34:56.123Z')],
    ] as const) {
      const description = await describeQuery({ connection: testConnection, query, codecs });
      assert.deepEqual(
        description.columns.map(({ readType }) => readType),
        [
          '"queued" | "done"',
          '"queued" | "done"',
          '"queued" | "done"',
          'string',
          codecs.typescript(1184),
        ],
      );
      assert.deepEqual(
        description.columns.map(({ enumLabels }) => enumLabels),
        [['queued', 'done'], ['queued', 'done'], ['queued', 'done'], undefined, undefined],
      );
      assert.ok(description.columns.every(({ nullability }) => nullability === 'unknown'));
      // A domain parameter has its own wire OID; its base enum does not select its decoder.
      assert.equal(description.parameters[0]!.postgres, `${options.namespace}.wrapped_state`);
      assert.equal(description.parameters[0]!.readType, 'string');
      assert.equal(description.parameters[0]!.enumLabels, undefined);
      const native = createPool({ connectionString: testConnection, codecs });
      try {
        assert.deepEqual((await native.queryClassic(query, ['queued'])).rows, [
          { state: 'queued', optional: null, wrapped: 'done', states: '{queued,done}', at },
        ]);
      } finally {
        await native.close();
      }
    }
  });
});

test('inspection honors custom enum decoders without assigning catalog labels to transformed values', async () => {
  await project({ '0001_enum.up.sql': schema }, async (options) => {
    await migrate(options);
    const query = `SELECT state, wrapped FROM ${qualified(options.namespace, 'records')}`;
    const oid = (await pool.describe(query)).fields[0]!.dataTypeOid;
    for (const typescript of ['string', '"QUEUED" | "DONE"', undefined]) {
      const codecs = defaultCodecs.with(builtin.timestamptzDate).with({
        oid,
        text: {
          encode: String,
          decode: (value: string) => value.toUpperCase(),
          ...(typescript === undefined ? {} : { typescript }),
        },
      });
      const description = await describeQuery({ connection: testConnection, query, codecs });
      assert.ok(
        description.columns.every(({ readType }) => readType === (typescript ?? 'unknown')),
      );
      assert.ok(description.columns.every(({ enumLabels }) => enumLabels === undefined));
      assert.equal(
        description.issues.some(({ code }) => code === 'unmapped-type'),
        typescript === undefined,
      );
      const native = createPool({ connectionString: testConnection, codecs });
      try {
        assert.deepEqual((await native.queryClassic(query)).rows, [
          { state: 'QUEUED', wrapped: 'DONE' },
        ]);
      } finally {
        await native.close();
      }
    }
  });
});

test('enum inspection declarations compile for empty enums and escaped labels', async () => {
  await project(
    {
      '0001_enum.up.sql': `CREATE TYPE empty_state AS ENUM ();
        CREATE TYPE unusual_state AS ENUM ('quote''d', E'line\\nbreak');`,
    },
    async (options) => {
      await migrate(options);
      const query = `SELECT NULL::${qualified(options.namespace, 'empty_state')} AS empty,
        NULL::${qualified(options.namespace, 'unusual_state')} AS unusual`;
      const description = await describeQuery({ connection: testConnection, query });
      assert.deepEqual(description.columns[0]!.enumLabels, []);
      assert.equal(description.columns[0]!.readType, 'never');
      assert.deepEqual(description.columns[1]!.enumLabels, ["quote'd", 'line\nbreak']);
      assert.ok(description.rowType);
      await writeFile(join(options.directory, 'package.json'), '{"type":"module"}');
      await writeFile(
        join(options.directory, 'consumer.ts'),
        `${description.rowType}
        type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
        type Assert<T extends true> = T;
        type Empty = Assert<Equal<DescribedRow['empty'], null>>;
        type Unusual = Assert<Equal<DescribedRow['unusual'], "quote'd" | 'line\\nbreak' | null>>;
        `,
      );
      const config = join(options.directory, 'tsconfig.json');
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            target: 'ES2022',
            module: 'NodeNext',
            types: ['node'],
            typeRoots: [resolve('node_modules/@types')],
          },
          files: ['consumer.ts'],
        }),
      );
      for (const compiler of ['typescript', 'typescript-next']) {
        try {
          await run(process.execPath, [
            resolve('node_modules', compiler, 'bin/tsc'),
            '--project',
            config,
          ]);
        } catch (error) {
          throw new Error((error as { stdout?: string }).stdout ?? String(error), { cause: error });
        }
      }
      assert.deepEqual((await pool.queryClassic(query)).rows, [{ empty: null, unusual: null }]);
    },
  );
});

test('source checking proves catalog enum unions while retaining narrower and custom refinements as unproven', async () => {
  await project({ '0001_enum.up.sql': schema }, async (options) => {
    await migrate(options);
    await writeFile(join(options.directory, 'package.json'), '{"type":"module"}');
    const target = join(options.directory, 'queries.ts');
    const table = qualified(options.namespace, 'records');
    await writeFile(
      target,
      `import { sql } from '@kequtech/tenon-orm';
      type State = 'queued' | 'done';
      type Branded = State & { readonly brand: unique symbol };
      export const exact = sql<{state: State}>\`SELECT state FROM ${table}\`;
      export const broad = sql<{state: string}>\`SELECT state FROM ${table}\`;
      export const superset = sql<{state: State | 'other'}>\`SELECT state FROM ${table}\`;
      export const narrow = sql<{state: 'queued'}>\`SELECT state FROM ${table}\`;
      export const branded = sql<{state: Branded}>\`SELECT state FROM ${table}\`;
      export const wrong = sql<{state: number}>\`SELECT state FROM ${table}\`;
      export const parameter = sql<{state: State}>\`SELECT state FROM ${table} WHERE state = \${'not-an-enum-label'}\`;
      `,
    );
    const config = join(options.directory, 'tsconfig.json');
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          skipLibCheck: true,
          types: ['node'],
          typeRoots: [resolve('node_modules/@types')],
          paths: { '@kequtech/tenon-orm': [resolve('dist/index.d.ts')] },
        },
        files: ['queries.ts'],
      }),
    );
    const codecs = defaultCodecs.with(builtin.timestamptzDate);
    const report = await checkQueries({ connection: testConnection, project: config, codecs });
    assert.equal(report.queries.length, 7);
    assert.ok(report.queries.every(({ status }) => status === 'analysed'));
    for (const query of report.queries.slice(0, 3)) {
      assert.ok(
        !query.diagnostics.some(
          ({ code }) =>
            code === 'result-refinement-unproven' || code === 'result-representation-unproven',
        ),
      );
    }
    for (const query of report.queries.slice(3, 5)) {
      assert.ok(query.diagnostics.some(({ code }) => code === 'result-refinement-unproven'));
      assert.ok(query.diagnostics.every(({ kind }) => kind === 'unproven'));
    }
    assert.equal(
      report.queries[5]!.diagnostics.filter(({ kind }) => kind === 'mismatch').length,
      1,
    );
    assert.equal(
      report.queries[5]!.diagnostics.find(({ kind }) => kind === 'mismatch')!.code,
      'result-type-mismatch',
    );
    assert.ok(
      report.queries[6]!.diagnostics.some(({ code }) => code === 'parameter-value-unproven'),
    );
    assert.ok(report.queries[6]!.diagnostics.every(({ kind }) => kind === 'unproven'));
    assert.equal(report.ok, false);

    // A decoder's declared string output still cannot prove the catalog label union.
    const oid = (await pool.describe(`SELECT state FROM ${table}`)).fields[0]!.dataTypeOid;
    const transformed = await checkQueries({
      connection: testConnection,
      project: config,
      target: `${target}:4`,
      codecs: codecs.with({
        oid,
        text: { encode: String, decode: (value) => value.toUpperCase(), typescript: 'string' },
      }),
    });
    assert.ok(transformed.diagnostics.some(({ code }) => code === 'result-refinement-unproven'));
    assert.equal(transformed.ok, true);
  });
});
