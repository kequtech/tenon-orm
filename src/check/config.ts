import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findConfig(project: string | undefined, directory: string): string {
  if (project !== undefined) {
    const path = resolve(project);
    return statSync(path, { throwIfNoEntry: false })?.isDirectory()
      ? resolve(path, 'tsconfig.json')
      : path;
  }
  for (;;) {
    const path = resolve(directory, 'tsconfig.json');
    if (existsSync(path)) return path;
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error('No tsconfig.json found. Pass --project with the project configuration.');
    directory = parent;
  }
}

interface Configuration {
  compilerOptions: Record<string, unknown>;
  files?: string[];
  references?: { path: string }[];
}

/** Ask the native compiler for root files and references, preserving option inheritance. */
export function checkerConfig(path: string, helper: string): string {
  const compiler = resolve(
    dirname(fileURLToPath(import.meta.resolve('typescript/package.json'))),
    'bin/tsc',
  );
  const result = spawnSync(process.execPath, [compiler, '--showConfig', '--project', path], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      result.stdout.trim() ||
        result.stderr.trim() ||
        'Cannot read TypeScript project configuration.',
    );
  const config = JSON.parse(result.stdout) as Configuration;
  if (!(config.compilerOptions.strictNullChecks ?? config.compilerOptions.strict))
    throw new Error('Query checking requires strictNullChecks in the TypeScript project.');
  // Keep the original inheritance chain: relative path aliases belong to the config
  // that declares them. References, unlike compiler options, are not inherited.
  return JSON.stringify({
    extends: path,
    compilerOptions: { noEmit: true, rootDir: null },
    files: [...(config.files ?? []), helper],
    include: [],
    references: config.references,
  });
}
