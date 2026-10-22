import { execFile } from 'node:child_process';
import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TenonError } from './errors.js';
import { baselineHeader, withMigrationCreationLock } from './migrations.js';
import { qualified, quote } from './sql.js';
import { migrationTable } from './tooling.js';

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
export interface CapturedBaseline { readonly id: string; readonly upPath: string }
const run = promisify(execFile);

/** Bridge pg_dump's plain-text script to pg's transactional SQL execution. */
function migrationSql(dump: string, namespace: string): string {
  // Recent pg_dump versions bracket psql scripts with a random restrict key.
  // Remove only the outer pair; SQL bodies containing similar text stay intact.
  const opening = /^\\restrict ([A-Za-z0-9]+)\r?$/m.exec(dump);
  if (opening) {
    const closing = dump.lastIndexOf(`\\unrestrict ${opening[1]}`);
    if (closing < opening.index) throw new TenonError('pg_dump output has an incomplete psql wrapper.');
    dump = dump.slice(0, closing) + dump.slice(closing).replace(/^\\unrestrict [A-Za-z0-9]+\r?\n?/, '');
    dump = dump.slice(0, opening.index) + dump.slice(opening.index + opening[0].length);
  }
  // Only the native preamble and bookkeeping schema declaration need adapting. Never
  // rewrite SET/CREATE text inside functions or other captured object bodies.
  const start = dump.indexOf('\n-- Name:');
  const preamble = start === -1 ? dump : dump.slice(0, start);
  let objects = start === -1 ? '' : dump.slice(start);
  const declaration = `\nCREATE SCHEMA ${quote(namespace)};`;
  const position = objects.indexOf(declaration);
  const section = objects.lastIndexOf('\n-- Name:', position);
  const isSchemaDeclaration = position !== -1 && objects.slice(Math.max(section, 0), position).split('\n')
    .every(line => !line.trim() || line.startsWith('--'));
  if (isSchemaDeclaration) objects = objects.replace(declaration, `\nCREATE SCHEMA IF NOT EXISTS ${quote(namespace)};`);
  return baselineHeader + preamble.replace(/^SET /gm, 'SET LOCAL ')
    .replace("SELECT pg_catalog.set_config('search_path', '', false);", "SELECT pg_catalog.set_config('search_path', '', true);") + objects;
}

/** Capture schema only. No source history writes, comparisons or ORM cleanup. */
export async function captureBaseline(options: CaptureBaselineOptions): Promise<CapturedBaseline> {
  const namespace = options.namespace ?? 'public';
  quote(namespace);
  const schemas = options.schemas?.map(schema => `--schema=${quote(schema)}`) ?? [];
  return withMigrationCreationLock(options.directory ?? 'migrations', async directory => {
    if ((await readdir(directory)).some(name => name.endsWith('.sql'))) {
      throw new TenonError('Baseline capture requires an empty Tenon migration directory. Existing files were not changed.');
    }
    const temporary = await mkdtemp(join(directory, '.tenon-baseline-'));
    try {
      const file = join(temporary, 'dump.sql');
      let warnings: string;
      try {
        const result = await run('pg_dump', ['--dbname', options.connection, '--no-password', '--schema-only',
          '--no-owner', '--no-privileges', '--quote-all-identifiers', '--strict-names',
          ...schemas, `--exclude-table=${qualified(namespace, migrationTable)}`, '--file', file]);
        warnings = result.stderr.trim();
      } catch (error) {
        // execFile's Error includes argv, potentially containing credentials.
        // Do not propagate that Error, its command line, or a credential-bearing cause.
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          throw new TenonError('Baseline capture requires pg_dump on PATH. Install PostgreSQL client tools.');
        }
        throw new TenonError('pg_dump failed. Check database access, permissions and PostgreSQL client/server compatibility. No baseline was written.');
      }
      if (warnings) (options.onWarning ?? console.warn)(warnings);
      const upPath = join(directory, '0001_baseline.up.sql');
      const prepared = join(temporary, 'migration.sql');
      await writeFile(prepared, migrationSql(await readFile(file, 'utf8'), namespace));
      // Publish a complete file atomically without replacing an existing path.
      await link(prepared, upPath);
      return { id: '0001', upPath };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}
