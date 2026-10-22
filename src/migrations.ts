import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { TenonError } from './errors.js';
import { qualified, quote } from './sql.js';
import { validateMigrationSql } from './migration-sql.js';
import { migrationTable, withToolConnection } from './tooling.js';
import type { DatabaseToolOptions } from './tooling.js';

export interface SqlMigration {
  readonly id: string;
  readonly name: string;
  readonly up: string;
  readonly down?: string;
  readonly checksum: string;
}
interface AppliedMigration { id: string; name: string; checksum: string }
export interface MigrationStatus { readonly applied: readonly string[]; readonly pending: readonly string[] }
export interface CreateMigrationOptions { readonly name: string; readonly directory?: string }
export interface CreatedMigration { readonly id: string; readonly upPath: string; readonly downPath: string }
const migrationFilename = /^(\d+)_([A-Za-z0-9_-]+)\.(up|down)\.sql$/;
export const baselineHeader = '-- Tenon baseline captured by pg_dump.\n';

/** Serialize offline scaffolding and baseline capture in one directory. */
export async function withMigrationCreationLock<T>(directory: string, work: (directory: string) => Promise<T>): Promise<T> {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, '.tenon-create.lock');
  // Serialize local numbering even when two processes choose different names.
  const lock = await open(lockPath, 'wx').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new TenonError(`Migration creation lock exists at ${lockPath}; another creator may be running. Remove a stale lock only after that process has stopped.`);
    throw error;
  });
  try {
    return await work(directory);
  } finally {
    try { await lock.close(); }
    finally { await unlink(lockPath); }
  }
}

/** Scaffold empty SQL files offline; authors supply both migration bodies. */
export async function createMigration(options: CreateMigrationOptions): Promise<CreatedMigration> {
  if (typeof options.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(options.name)) throw new TenonError('Migration names must contain only letters, digits, underscores or hyphens.');
  return withMigrationCreationLock(options.directory ?? 'migrations', async directory => {
    let latest = 0n;
    let width = 4;
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.sql')) continue;
      const match = migrationFilename.exec(file.name);
      if (!match) throw new TenonError(`Invalid migration filename: ${file.name}`);
      const id = BigInt(match[1]!);
      if (id > latest) latest = id;
      width = Math.max(width, match[1]!.length);
    }
    const id = (latest + 1n).toString().padStart(width, '0');
    const upPath = join(directory, `${id}_${options.name}.up.sql`);
    const downPath = join(directory, `${id}_${options.name}.down.sql`);
    await writeFile(upPath, '', { flag: 'wx' });
    try { await writeFile(downPath, '', { flag: 'wx' }); }
    catch (error) {
      try { await unlink(upPath); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Migration creation and cleanup failed.'); }
      throw error;
    }
    return { id, upPath, downPath };
  });
}

export async function readMigrations(directory = 'migrations'): Promise<readonly SqlMigration[]> {
  const files = await readdir(directory, { withFileTypes: true });
  const groups = new Map<string, { name: string; up?: string; down?: string }>();
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.sql')) continue;
    const match = migrationFilename.exec(file.name);
    if (!match) throw new TenonError(`Invalid migration filename: ${file.name}; use 0001_description.up.sql and optional .down.sql.`);
    const id = match[1]!;
    const name = match[2]!;
    const direction = match[3] as 'up' | 'down';
    const group = groups.get(id) ?? { name };
    if (group.name !== name || group[direction] !== undefined) throw new TenonError(`Duplicate migration version: ${id}`);
    const sql = await readFile(join(directory, file.name), 'utf8');
    if (!sql.trim()) throw new TenonError(`Empty migration: ${file.name}`);
    // Trust native pg_dump SQL, including SQL-standard function bodies that the
    // authored-migration transaction guard does not attempt to parse.
    if (!(file.name === '0001_baseline.up.sql' && sql.startsWith(baselineHeader))) validateMigrationSql(sql, file.name);
    group[direction] = sql;
    groups.set(id, group);
  }
  const sorted = [...groups].sort(([a], [b]) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  return sorted.map(([id, group], i) => {
    if (i && BigInt(sorted[i - 1]![0]) === BigInt(id)) throw new TenonError(`Duplicate migration version: ${id}`);
    if (group.up === undefined) throw new TenonError(`Migration ${id} has a down file without an up file.`);
    return { id, name: group.name, up: group.up, ...(group.down === undefined ? {} : { down: group.down }),
      checksum: createHash('sha256').update(JSON.stringify([group.up, group.down ?? null])).digest('hex'),
    };
  });
}

export async function migrationState(client: PoolClient, namespace: string, migrations: readonly SqlMigration[]): Promise<readonly AppliedMigration[]> {
  const exists = await client.query<{ name: string | null }>('SELECT to_regclass($1)::text AS name', [qualified(namespace, migrationTable)]);
  const applied = exists.rows[0]!.name === null ? [] : (await client.query<AppliedMigration>(`SELECT id, name, checksum FROM ${qualified(namespace, migrationTable)} ORDER BY id::numeric`)).rows;
  for (const [i, record] of applied.entries()) {
    const file = migrations[i];
    if (!file || file.id !== record.id || file.name !== record.name || file.checksum !== record.checksum) {
      throw new TenonError(`Migration history differs from files at version ${record.id}; restore applied files before continuing.`);
    }
  }
  return applied;
}

export async function migrationStatus(options: DatabaseToolOptions): Promise<MigrationStatus> {
  const files = await readMigrations(options.directory);
  return withToolConnection(options, true, async (client, namespace) => {
    const applied = await migrationState(client, namespace, files);
    return { applied: applied.map(m => m.id), pending: files.slice(applied.length).map(m => m.id) };
  });
}

async function createHistoryTable(client: PoolClient, namespace: string): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ${qualified(namespace, migrationTable)} (id TEXT PRIMARY KEY CHECK (id ~ '^[0-9]+$'), name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}

/** Acknowledge the saved baseline on an existing database; never execute its SQL. */
export async function adoptBaseline(options: DatabaseToolOptions): Promise<readonly string[]> {
  const files = await readMigrations(options.directory);
  const baseline = files[0];
  if (!baseline || baseline.id !== '0001' || baseline.name !== 'baseline' || baseline.down !== undefined) {
    throw new TenonError('Adoption requires 0001_baseline.up.sql with no down file. Capture and commit a baseline first.');
  }
  return withToolConnection(options, false, async (client, namespace) => {
    const applied = await migrationState(client, namespace, files);
    if (applied.length) return [];
    const schema = await client.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [namespace]);
    if (!schema.rows.length) throw new TenonError('The baseline namespace does not exist. Use migrate to initialize a fresh database.');
    await client.query('BEGIN');
    await createHistoryTable(client, namespace);
    await client.query(`INSERT INTO ${qualified(namespace, migrationTable)} (id, name, checksum) VALUES ($1, $2, $3)`, [baseline.id, baseline.name, baseline.checksum]);
    const result = await client.query('COMMIT');
    if (result.command !== 'COMMIT') throw new TenonError('Baseline adoption was rolled back.');
    return [baseline.id];
  });
}

async function execute(options: DatabaseToolOptions, direction: 'up' | 'down', steps: number): Promise<readonly string[]> {
  if (!Number.isSafeInteger(steps) || steps < 1) throw new TenonError('Rollback steps must be a positive safe integer.');
  const files = await readMigrations(options.directory);
  return withToolConnection(options, false, async (client, namespace) => {
    const applied = await migrationState(client, namespace, files);
    const selected = direction === 'up' ? files.slice(applied.length) : files.slice(Math.max(0, applied.length - steps), applied.length).reverse();
    if (direction === 'down' && selected.some(file => file.down === undefined)) throw new TenonError('A selected migration has no down SQL and cannot be rolled back.');
    if (!selected.length) return [];
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(namespace)}`);
    await createHistoryTable(client, namespace);
    const completed: string[] = [];
    for (const file of selected) {
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path TO ${quote(namespace)}, pg_catalog`);
        await client.query(direction === 'up' ? file.up : file.down!);
        if (direction === 'up') await client.query(`INSERT INTO ${qualified(namespace, migrationTable)} (id, name, checksum) VALUES ($1, $2, $3)`, [file.id, file.name, file.checksum]);
        else await client.query(`DELETE FROM ${qualified(namespace, migrationTable)} WHERE id = $1`, [file.id]);
        const result = await client.query('COMMIT');
        if (result.command !== 'COMMIT') throw new TenonError('The migration transaction was rolled back.');
        completed.push(file.id);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : 'Unknown database error';
        throw new TenonError(`Migration ${file.id}_${file.name} (${direction}) failed: ${reason}. Earlier migrations in this run may have committed.`, { cause });
      }
    }
    return completed;
  });
}

export function migrate(options: DatabaseToolOptions): Promise<readonly string[]> { return execute(options, 'up', 1); }
export function rollback(options: DatabaseToolOptions & { readonly steps?: number }): Promise<readonly string[]> { return execute(options, 'down', options.steps ?? 1); }
