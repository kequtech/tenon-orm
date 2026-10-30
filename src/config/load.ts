import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TenonConfig } from '../config.js';
import { sessionOptions, timeoutOptions } from '../inspection/options.js';
import { validateName } from '../sql.js';
import { plainObject, validatePath } from '../validation.js';

export const configNames = [
  'tenon.config.ts',
  'tenon.config.mts',
  'tenon.config.js',
  'tenon.config.mjs',
];

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function keys(value: unknown, label: string, allowed: readonly string[]) {
  const config = plainObject(value, label);
  for (const key of Object.keys(config)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} option: ${key}`);
  }
  return config;
}

/** Find configuration without importing it, including for offline initialization. */
export async function findConfig(directory = process.cwd()): Promise<string | undefined> {
  while (true) {
    const candidates = await Promise.all(
      configNames.map(async (name) => {
        const candidate = join(directory, name);
        return (await exists(candidate)) ? candidate : undefined;
      }),
    );
    const found = candidates.filter((candidate) => candidate !== undefined);
    if (found.length > 1)
      throw new Error(`Multiple Tenon config files in ${directory}; select one with --config.`);
    if (found.length) {
      return found[0];
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Import only the selected trusted configuration module; never discover application entry points. */
export function loadConfig(filename?: string): Promise<TenonConfig>;
export function loadConfig(
  filename: string | undefined,
  required: false,
): Promise<TenonConfig | undefined>;
export async function loadConfig(
  filename?: string,
  required = true,
): Promise<TenonConfig | undefined> {
  if (filename !== undefined) validatePath(filename, 'Config filename');
  const selected = filename === undefined ? await findConfig() : resolve(filename);
  if (!selected && !required) return undefined;
  if (!selected)
    throw new Error('Tenon configuration is required. Run tenon init or pass --config.');
  let value: unknown;
  try {
    value = (await import(pathToFileURL(selected).href)).default;
  } catch {
    // Import errors may contain credentials from environment validation or dependency messages.
    throw new Error(
      `Could not load Tenon configuration: ${selected}. Check the module and its imports.`,
    );
  }
  const config = keys(value, 'Tenon config', [
    'connection',
    'generate',
    'migrations',
    'baseline',
    'check',
    'session',
    'timeouts',
  ]);
  if (typeof config.connection === 'string') {
    if (!config.connection.trim()) throw new Error('Tenon config connection must be nonempty.');
  } else {
    const connection = plainObject(config.connection, 'Tenon config connection');
    if ('acquire' in connection || 'close' in connection) {
      throw new Error('Tenon config requires connection options, not an open pool.');
    }
  }
  const root = dirname(selected);
  const migrations = keys(
    config.migrations === undefined ? {} : config.migrations,
    'migration config',
    ['directory', 'namespace'],
  );
  if (migrations.directory !== undefined) validatePath(migrations.directory, 'Migration directory');
  if (migrations.namespace !== undefined) validateName(migrations.namespace as string);
  let generate: TenonConfig['generate'];
  if (config.generate !== undefined) {
    const options = keys(config.generate, 'generation config', ['out', 'namespace']);
    validatePath(options.out, 'Generation out');
    if (options.namespace !== undefined) validateName(options.namespace as string);
    generate = {
      out: resolve(root, options.out),
      ...(options.namespace !== undefined && { namespace: options.namespace as string }),
    };
  }
  const check = keys(config.check === undefined ? {} : config.check, 'checking config', [
    'project',
    'readTypes',
  ]);
  if (check.project !== undefined) validatePath(check.project, 'Checking project');
  if (check.readTypes !== undefined) {
    const mappings = plainObject(check.readTypes, 'Checking readTypes');
    for (const [oid, expression] of Object.entries(mappings)) {
      if (
        !/^[1-9]\d*$/.test(oid) ||
        Number(oid) > 0xffffffff ||
        typeof expression !== 'string' ||
        !expression.trim()
      ) {
        throw new Error(
          'Checking readTypes requires PostgreSQL OIDs and nonempty type expressions.',
        );
      }
    }
  }
  const baseline = keys(config.baseline === undefined ? {} : config.baseline, 'baseline config', [
    'connection',
    'schemas',
  ]);
  if (
    baseline.connection !== undefined &&
    (typeof baseline.connection !== 'string' ||
      !baseline.connection.trim() ||
      baseline.connection.includes('\0'))
  ) {
    throw new Error('Baseline connection must be a nonempty native libpq connection string.');
  }
  if (baseline.schemas !== undefined) {
    if (!Array.isArray(baseline.schemas) || !baseline.schemas.length)
      throw new Error('Baseline schemas must be a nonempty array.');
    for (const schema of baseline.schemas) validateName(schema as string);
  }
  const session = sessionOptions(config.session === undefined ? {} : config.session);
  const timeouts = timeoutOptions(config.timeouts === undefined ? {} : config.timeouts);
  return {
    connection: config.connection as TenonConfig['connection'],
    migrations: {
      directory: resolve(root, (migrations.directory as string | undefined) ?? 'migrations'),
      ...(migrations.namespace !== undefined && { namespace: migrations.namespace as string }),
    },
    ...(generate !== undefined && { generate }),
    check: {
      project: resolve(root, (check.project as string | undefined) ?? 'tsconfig.json'),
      ...(check.readTypes !== undefined && {
        readTypes: check.readTypes as Readonly<Record<number, string>>,
      }),
    },
    ...(config.baseline !== undefined && {
      baseline: {
        ...(baseline.connection !== undefined && { connection: baseline.connection as string }),
        ...(baseline.schemas !== undefined && { schemas: [...(baseline.schemas as string[])] }),
      },
    }),
    session,
    timeouts,
  };
}
