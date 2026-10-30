import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TenonConfig } from '../config.js';
import { sessionOptions, timeoutOptions } from '../inspection/options.js';
import { validateName } from '../sql.js';
import { plainObject, validatePath } from '../validation.js';
import { configObject, configSection } from './validate.js';

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

function selectDatabase(exports: Record<string, unknown>, database: string | undefined): unknown {
  const names = Object.keys(exports).filter((name) => {
    const value = exports[name];
    return (
      name === 'default' || (value !== null && typeof value === 'object' && 'connection' in value)
    );
  });
  if (database !== undefined && !names.includes(database)) {
    throw new Error(
      `Unknown database export: ${database}. Available: ${names.join(', ') || 'none'}.`,
    );
  }
  if (database === undefined && names.length !== 1) {
    throw new Error(
      names.length
        ? `Multiple databases exported: ${names.join(', ')}. Select one with --database.`
        : 'No database configurations exported. Export a Tenon config with a connection field.',
    );
  }
  return exports[database ?? names[0]!];
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
export function loadConfig(filename?: string, database?: string): Promise<TenonConfig>;
export function loadConfig(
  filename: string | undefined,
  database: string | undefined,
  required: false,
): Promise<TenonConfig | undefined>;
export async function loadConfig(
  filename?: string,
  database?: string,
  required = true,
): Promise<TenonConfig | undefined> {
  if (filename !== undefined) validatePath(filename, 'Config filename');
  if (database !== undefined && (!database.trim() || database.includes('\0'))) {
    throw new Error('--database must be a nonempty export name without NUL.');
  }
  const selected = filename === undefined ? await findConfig() : resolve(filename);
  if (!selected && !required && database === undefined) return undefined;
  if (!selected)
    throw new Error('Tenon configuration is required. Run tenon init or pass --config.');
  let exports: Record<string, unknown>;
  try {
    exports = await import(pathToFileURL(selected).href);
  } catch {
    // Import errors may contain credentials from environment validation or dependency messages.
    throw new Error(
      `Could not load Tenon configuration: ${selected}. Check the module and its imports.`,
    );
  }
  const config = configObject(selectDatabase(exports, database));
  const root = dirname(selected);
  const migrations = configSection(
    config.migrations === undefined ? {} : config.migrations,
    'migration config',
    ['directory', 'namespace'],
  );
  if (migrations.directory !== undefined) validatePath(migrations.directory, 'Migration directory');
  if (migrations.namespace !== undefined) validateName(migrations.namespace as string);
  let generate: TenonConfig['generate'];
  if (config.generate !== undefined) {
    const options = configSection(config.generate, 'generation config', ['out', 'namespace']);
    validatePath(options.out, 'Generation out');
    if (options.namespace !== undefined) validateName(options.namespace as string);
    generate = {
      out: resolve(root, options.out),
      ...(options.namespace !== undefined && { namespace: options.namespace as string }),
    };
  }
  const check = configSection(config.check === undefined ? {} : config.check, 'checking config', [
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
  const baseline = configSection(
    config.baseline === undefined ? {} : config.baseline,
    'baseline config',
    ['connection', 'schemas'],
  );
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
    ...(config.onQuery !== undefined && {
      onQuery: config.onQuery as NonNullable<TenonConfig['onQuery']>,
    }),
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
