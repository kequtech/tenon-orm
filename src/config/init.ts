import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { validatePath } from '../validation.js';
import { configNames, findConfig } from './load.js';

/** Scaffold one value-only config, without importing existing application code or opening a pool. */
export async function initConfig(filename?: string): Promise<string> {
  if (filename !== undefined) validatePath(filename, 'Config filename');
  const output = resolve(filename ?? 'tenon.config.ts');
  const extension = extname(output);
  if (!['.ts', '.mts', '.js', '.mjs'].includes(extension)) {
    throw new Error('Config filename must end in .ts, .mts, .js, or .mjs.');
  }
  if (filename === undefined || configNames.includes(basename(output))) {
    const existing = await findConfig(dirname(output));
    if (existing && (filename === undefined || dirname(existing) === dirname(output))) {
      throw new Error(`Tenon configuration already exists: ${existing}. Use or edit that file.`);
    }
  }
  const typed = extension === '.ts' || extension === '.mts';
  const source = `${typed ? "import type { TenonConfig } from '@kequtech/tenon-orm';\n\n" : ''}export const main = {
  connection: { connectionString: process.env.DATABASE_URL },
  migrations: { directory: 'migrations', namespace: 'public' },
  generate: { out: 'src/generated-schema.d.ts' },
  check: { project: 'tsconfig.json' },
}${typed ? ' satisfies TenonConfig' : ''};
`;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, source, { encoding: 'utf8', flag: 'wx' });
  return output;
}
