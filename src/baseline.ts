import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareBaselineSql } from './migrations/baseline-sql.js';
import { withMigrationLock } from './migrations/connection.js';
import { withMigrationCreationLock } from './migrations/files.js';
import {
  checkpointCatalog,
  checkpointFilename,
  checkpointHash,
  readBaselineSchemas,
  type BaselineCheckpoint,
} from './migrations/checkpoint.js';
import { migrationTable } from './migrations/history.js';
import { qualified, quote } from './sql.js';

export interface CaptureBaselineOptions {
  /** PostgreSQL URI usable by pgclear and native pg_dump. */
  readonly connection: string;
  readonly namespace?: string;
  /** Optional native pg_dump schema selection; omitted captures the whole database schema. */
  readonly schemas?: readonly string[];
  /** Native pg_dump table patterns, e.g. public.kysely_migration. Source tables are untouched. */
  readonly excludeTables?: readonly string[];
  readonly directory?: string;
  /** Receives native pg_dump warnings; defaults to console.warn. */
  readonly onWarning?: (message: string) => void;
}
export interface CapturedBaseline {
  readonly id: string;
  readonly upPath: string;
  readonly checkpointPath: string;
}
const run = promisify(execFile);

/** Capture a portable schema; deployment provisioning owns role-specific security. */
export async function captureBaseline(options: CaptureBaselineOptions): Promise<CapturedBaseline> {
  if (typeof options.connection !== 'string' || !options.connection.trim()) {
    throw new Error('Baseline capture requires an explicit nonempty connection string.');
  }
  if (options.schemas !== undefined && options.schemas.length === 0) {
    throw new Error(
      'Baseline schemas must not be empty; omit schemas to capture the whole database schema.',
    );
  }
  const namespace = options.namespace ?? 'public';
  quote(namespace);
  const schemas = options.schemas?.map((schema) => `--schema=${quote(schema)}`) ?? [];
  const excluded = options.excludeTables === undefined ? [] : options.excludeTables;
  if (
    !Array.isArray(excluded) ||
    Array.from(excluded).some(
      (pattern) => typeof pattern !== 'string' || !pattern.trim() || pattern.includes('\0'),
    )
  ) {
    throw new Error(
      'Baseline excludeTables must be an array of nonempty pg_dump patterns without NUL.',
    );
  }
  return withMigrationCreationLock(options.directory ?? 'migrations', async (directory) => {
    if (
      (await readdir(directory)).some(
        (name) => name.endsWith('.sql') || name === checkpointFilename,
      )
    ) {
      throw new Error(
        'Baseline capture requires an empty Tenon migration directory. Existing files were not changed.',
      );
    }
    const temporary = await mkdtemp(join(directory, '.tenon-baseline-'));
    try {
      const file = join(temporary, 'dump.sql');
      const captured = await withMigrationLock(
        { connection: options.connection, namespace },
        'shared',
        (client) =>
          client.transaction(
            async (transaction) => {
              const catalog = checkpointCatalog(transaction);
              const snapshot = await catalog.query<{ id: string }>(
                'SELECT pg_catalog.pg_export_snapshot() AS id',
              );
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
                  `--snapshot=${snapshot.rows[0]!.id}`,
                  ...schemas,
                  `--exclude-table=${qualified(namespace, migrationTable)}`,
                  ...excluded.map((pattern) => `--exclude-table=${pattern}`),
                  '--file',
                  file,
                ]);
                warnings = result.stderr.trim();
              } catch (error) {
                // execFile's Error includes argv, potentially containing credentials.
                // Do not propagate that Error, its command line, or a credential-bearing cause.
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                  throw new Error(
                    'Baseline capture requires pg_dump on PATH. Install PostgreSQL client tools.',
                  );
                }
                throw new Error(
                  'pg_dump failed. Check database access, permissions and PostgreSQL client/server compatibility. No baseline was written.',
                );
              }
              if (warnings) {
                (options.onWarning ?? console.warn)(warnings);
              }

              const namespaces =
                options.schemas ??
                (
                  await catalog.query<{ name: string }>(
                    `SELECT nspname AS name FROM pg_catalog.pg_namespace
             WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'
             ORDER BY nspname COLLATE "C"`,
                  )
                ).rows.map((row) => row.name);
              const up = prepareBaselineSql(await readFile(file, 'utf8'), namespace);
              const checkpoint: BaselineCheckpoint = {
                formatVersion: 1,
                namespace,
                migrationChecksum: createHash('sha256')
                  .update(JSON.stringify([up, null]))
                  .digest('hex'),
                schemas: await readBaselineSchemas(catalog, [...new Set(namespaces)].sort()),
              };
              return { up, checkpoint: { ...checkpoint, fingerprint: checkpointHash(checkpoint) } };
            },
            { isolation: 'repeatable read', readOnly: true },
          ),
      );
      const upPath = join(directory, '0001_baseline.up.sql');
      const checkpointPath = join(directory, checkpointFilename);
      const prepared = join(temporary, 'migration.sql');
      const preparedCheckpoint = join(temporary, 'checkpoint.json');
      await writeFile(prepared, captured.up);
      await writeFile(preparedCheckpoint, JSON.stringify(captured.checkpoint, null, 2) + '\n');
      // Publish the checkpoint first, SQL last. A reader can never execute an incomplete pair.
      await link(preparedCheckpoint, checkpointPath);
      try {
        await link(prepared, upPath);
      } catch (error) {
        await rm(checkpointPath);
        throw error;
      }
      return { checkpointPath, id: '0001', upPath };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
