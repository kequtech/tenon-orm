import { execFile } from 'node:child_process';
import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TenonError } from './errors.js';
import { prepareBaselineSql } from './migrations/baseline-sql.js';
import type { DatabaseToolOptions } from './migrations/connection.js';
import { withMigrationLock } from './migrations/connection.js';
import { readMigrations, withMigrationCreationLock } from './migrations/files.js';
import {
  createHistoryTable,
  migrationState,
  migrationTable,
  recordMigration,
} from './migrations/history.js';
import { qualified, quote } from './sql.js';

export interface CaptureBaselineOptions {
  /** Native libpq connection string, passed directly to pg_dump. */
  readonly connection: string;
  readonly namespace?: string;
  /** Optional native pg_dump schema selection; omitted captures the whole database schema. */
  readonly schemas?: readonly string[];
  readonly directory?: string;
  /** Receives native pg_dump warnings; defaults to console.warn. */
  readonly onWarning?: (message: string) => void;
}
export interface CapturedBaseline {
  readonly id: string;
  readonly upPath: string;
}
const run = promisify(execFile);

/** Capture schema only. No source history writes, comparisons or ORM cleanup. */
export async function captureBaseline(options: CaptureBaselineOptions): Promise<CapturedBaseline> {
  const namespace = options.namespace ?? 'public';
  quote(namespace);
  const schemas = options.schemas?.map((schema) => `--schema=${quote(schema)}`) ?? [];
  return withMigrationCreationLock(options.directory ?? 'migrations', async (directory) => {
    if ((await readdir(directory)).some((name) => name.endsWith('.sql'))) {
      throw new TenonError(
        'Baseline capture requires an empty Tenon migration directory. Existing files were not changed.',
      );
    }
    const temporary = await mkdtemp(join(directory, '.tenon-baseline-'));
    try {
      const file = join(temporary, 'dump.sql');
      let warnings: string;
      try {
        const result = await run('pg_dump', [
          '--dbname',
          options.connection,
          '--no-password',
          '--schema-only',
          '--no-owner',
          '--no-privileges',
          '--quote-all-identifiers',
          '--strict-names',
          ...schemas,
          `--exclude-table=${qualified(namespace, migrationTable)}`,
          '--file',
          file,
        ]);
        warnings = result.stderr.trim();
      } catch (error) {
        // execFile's Error includes argv, potentially containing credentials.
        // Do not propagate that Error, its command line, or a credential-bearing cause.
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          throw new TenonError(
            'Baseline capture requires pg_dump on PATH. Install PostgreSQL client tools.',
          );
        }
        throw new TenonError(
          'pg_dump failed. Check database access, permissions and PostgreSQL client/server compatibility. No baseline was written.',
        );
      }
      if (warnings) {
        (options.onWarning ?? console.warn)(warnings);
      }
      const upPath = join(directory, '0001_baseline.up.sql');
      const prepared = join(temporary, 'migration.sql');
      await writeFile(prepared, prepareBaselineSql(await readFile(file, 'utf8'), namespace));
      // Publish a complete file atomically without replacing an existing path.
      await link(prepared, upPath);
      return { id: '0001', upPath };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

/** Acknowledge the saved baseline on an existing database; never execute its SQL. */
export async function adoptBaseline(options: DatabaseToolOptions): Promise<readonly string[]> {
  const files = await readMigrations(options.directory);
  const baseline = files[0];
  if (
    !baseline ||
    baseline.id !== '0001' ||
    baseline.name !== 'baseline' ||
    baseline.down !== undefined
  ) {
    throw new TenonError(
      'Adoption requires 0001_baseline.up.sql with no down file. Capture and commit a baseline first.',
    );
  }
  return withMigrationLock(options, 'exclusive', async (client, namespace) => {
    const applied = await migrationState(client, namespace, files);
    if (applied.length) {
      return [];
    }
    const schema = await client.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [
      namespace,
    ]);
    if (!schema.rows.length) {
      throw new TenonError(
        'The baseline namespace does not exist. Use migrate to initialize a fresh database.',
      );
    }
    await client.query('BEGIN');
    await createHistoryTable(client, namespace);
    await recordMigration(client, namespace, baseline);
    const result = await client.query('COMMIT');
    if (result.command !== 'COMMIT') {
      throw new TenonError('Baseline adoption was rolled back.');
    }
    return [baseline.id];
  });
}
