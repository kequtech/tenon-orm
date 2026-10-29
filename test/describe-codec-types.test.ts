import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { createPool, defaultCodecs } from '@kequtech/pgclear';
import { describeQuery } from '../src/index.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const pool = createPool(testConnection);
before(() => assertTestDatabase(pool));
after(() => pool.close());
const run = promisify(execFile);

test('custom Describe declarations preserve nullable function types, imported types and nested arrays', async () => {
  const codecs = defaultCodecs
    .with({
      oid: 23,
      text: { encode: String, decode: (value) => () => Number(value), typescript: '() => number' },
    })
    .with({
      oid: 25,
      text: {
        encode: String,
        decode: (value) => ({ items: [value, null] }),
        typescript: '{ items: PgArray<string> }',
      },
    })
    .with({
      oid: 1700,
      text: {
        encode: String,
        decode: (raw) => ({ raw }),
        typescript: 'import("./model.js").Decimal',
      },
    });
  const native = createPool({ connectionString: testConnection, codecs });
  const directory = await mkdtemp(join(tmpdir(), 'tenon-described-codecs-'));
  const query =
    "SELECT 42::integer AS callback, NULL::integer AS missing, 'text'::text AS box, 1.25::numeric AS decimal";
  try {
    const description = await describeQuery({ connection: testConnection, query, codecs });
    assert.ok(description.rowType);
    assert.ok(!description.issues.some(({ code }) => code === 'unmapped-type'));
    const row = (await native.queryClassic(query)).rows[0]!;
    assert.equal(typeof row.callback, 'function');
    if (typeof row.callback === 'function') assert.equal(row.callback(), 42);
    assert.equal(row.missing, null);
    assert.deepEqual(row.box, { items: ['text', null] });
    assert.deepEqual(row.decimal, { raw: '1.25' });

    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(join(directory, 'model.ts'), 'export interface Decimal { raw: string }');
    await writeFile(
      join(directory, 'consumer.ts'),
      `${description.rowType}
      import type { Decimal } from './model.js';
      declare const row: DescribedRow;
      const absentCallback: DescribedRow['callback'] = null;
      const callback = row.callback;
      if (callback !== null) {
        const value: number = callback();
      }
      // @ts-expect-error SQL NULL is a nullable function, not a nullable return value
      row.callback();
      const nested: DescribedRow['box'] = { items: [['nested', null], 'flat', null] };
      const absentBox: DescribedRow['box'] = null;
      const decimal: Decimal | null = row.decimal;
      // @ts-expect-error the declared decoder returns a string field
      const incorrect: DescribedRow['decimal'] = { raw: 1 };
      `,
    );
    const config = join(directory, 'tsconfig.json');
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
        await run(process.execPath, [resolve('node_modules', compiler, 'bin/tsc'), '-p', config]);
      } catch (error) {
        throw new Error((error as { stdout?: string }).stdout ?? String(error), { cause: error });
      }
    }
  } finally {
    await native.close();
    await rm(directory, { recursive: true, force: true });
  }
});
