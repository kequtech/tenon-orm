import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkQueries } from '../src/check.js';
import { errors, sourceProject } from './helpers/checker.js';

test('native checking preserves inherited JSONC configuration and project references without emitting files', async () => {
  await sourceProject(
    {
      'models/tsconfig.json': JSON.stringify({
        extends: '../tsconfig.json',
        compilerOptions: { composite: true, rootDir: '.', outDir: '../model-build', noEmit: false },
        files: ['row.ts'],
        include: [],
      }),
      'models/row.ts': 'export interface Row { id: number }',
      'app/tsconfig.json': `{
        // Comments and trailing commas belong to TypeScript configuration.
        "extends": "../tsconfig.json",
        "compilerOptions": { "composite": true, "rootDir": ".", },
        "files": ["queries.ts"],
        "include": [],
        "references": [{ "path": "../models" }],
      }`,
      'app/queries.ts': [
        'import { sql } from "@kequtech/tenon-orm";',
        'import type { Row } from "../models/row.js";',
        'throw new Error("The checker must never execute application modules");',
        'export const result = sql<Row>`SELECT 1 AS id`;',
      ].join('\n'),
    },
    async (options, directory) => {
      const report = await checkQueries({
        ...options,
        project: join(directory, 'app/tsconfig.json'),
      });
      assert.equal(report.ok, true, JSON.stringify(errors(report)));
      assert.deepEqual(report.coverage, { total: 1, analysed: 1, unchecked: 0 });
      assert.deepEqual((await readdir(directory)).sort(), [
        'app',
        'models',
        'package.json',
        'tsconfig.json',
      ]);
      assert.deepEqual((await readdir(join(directory, 'app'))).sort(), [
        'queries.ts',
        'tsconfig.json',
      ]);
    },
  );
});

test('native checking resolves relative path aliases from the config that declares them', async () => {
  await sourceProject(
    {
      'base.json': JSON.stringify({
        extends: './tsconfig.json',
        compilerOptions: {
          paths: {
            '@kequtech/tenon-orm': [join(process.cwd(), 'dist/index.d.ts')],
            '@models/*': ['./models/*'],
          },
        },
      }),
      'models/row.ts': 'export interface Row { id: number }',
      'app/tsconfig.json': JSON.stringify({
        extends: '../base.json',
        files: ['queries.ts'],
        include: [],
      }),
      'app/queries.ts': [
        'import { sql } from "@kequtech/tenon-orm";',
        'import type { Row } from "@models/row.js";',
        'export const exact = sql<Row>`SELECT 1 AS id`;',
        'export const wrong = sql<Row>`SELECT true AS id`;',
      ].join('\n'),
    },
    async (options, directory) => {
      const report = await checkQueries({
        ...options,
        project: join(directory, 'app/tsconfig.json'),
      });
      assert.deepEqual(report.coverage, { total: 2, analysed: 2, unchecked: 0 });
      assert.deepEqual(report.queries[0]!.diagnostics, []);
      assert.deepEqual(
        report.queries[1]!.diagnostics.map(({ code }) => code),
        ['result-type-mismatch'],
      );
      assert.ok(!report.diagnostics.some(({ code }) => code === 'typescript-error'));
    },
  );
});
