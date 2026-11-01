import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CheckOptions, CheckReport } from '../../src/check.js';
import { testConnection } from './database.js';

export async function sourceProject(
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

export function errors(report: CheckReport) {
  return report.diagnostics.filter(({ kind }) => kind !== 'unproven');
}
