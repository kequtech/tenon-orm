import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { baselineHeader } from './baseline-sql.js';
import { validateMigrationSql } from './sql.js';

export interface SqlMigration {
  readonly id: string;
  readonly name: string;
  readonly up: string;
  readonly down?: string;
  readonly checksum: string;
}
export interface CreateMigrationOptions {
  readonly name: string;
  readonly directory?: string;
}
export interface CreatedMigration {
  readonly id: string;
  readonly upPath: string;
  readonly downPath: string;
}
const migrationFilename = /^(\d+)_([A-Za-z0-9_-]+)\.(up|down)\.sql$/;

/** Serialize offline scaffolding and baseline capture in one directory. */
export async function withMigrationCreationLock<T>(
  directory: string,
  work: (directory: string) => Promise<T>,
): Promise<T> {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, '.tenon-create.lock');
  // Serialize local numbering even when two processes choose different names.
  const lock = await open(lockPath, 'wx').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `Migration creation lock exists at ${lockPath}; another creator may be running. Remove a stale lock only after that process has stopped.`,
      );
    }
    throw error;
  });
  try {
    return await work(directory);
  } finally {
    try {
      await lock.close();
    } finally {
      await unlink(lockPath);
    }
  }
}

/** Scaffold empty SQL files offline; authors supply both migration bodies. */
export async function createMigration(options: CreateMigrationOptions): Promise<CreatedMigration> {
  if (typeof options.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(options.name)) {
    throw new Error('Migration names must contain only letters, digits, underscores or hyphens.');
  }
  return withMigrationCreationLock(options.directory ?? 'migrations', async (directory) => {
    let latest = 0n;
    let width = 4;
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.sql')) {
        continue;
      }
      const match = migrationFilename.exec(file.name);
      if (!match) {
        throw new Error(`Invalid migration filename: ${file.name}`);
      }
      const id = BigInt(match[1]!);
      if (id > latest) {
        latest = id;
      }
      width = Math.max(width, match[1]!.length);
    }
    const id = (latest + 1n).toString().padStart(width, '0');
    const upPath = join(directory, `${id}_${options.name}.up.sql`);
    const downPath = join(directory, `${id}_${options.name}.down.sql`);
    await writeFile(upPath, '', { flag: 'wx' });
    try {
      await writeFile(downPath, '', { flag: 'wx' });
    } catch (error) {
      try {
        await unlink(upPath);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Migration creation and cleanup failed.');
      }
      throw error;
    }
    return { id, upPath, downPath };
  });
}

export async function readMigrations(directory = 'migrations'): Promise<readonly SqlMigration[]> {
  const files = await readdir(directory, { withFileTypes: true });
  const groups = new Map<string, { name: string; up?: string; down?: string }>();
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.sql')) {
      continue;
    }
    const match = migrationFilename.exec(file.name);
    if (!match) {
      throw new Error(
        `Invalid migration filename: ${file.name}; use 0001_description.up.sql and optional .down.sql.`,
      );
    }
    const id = match[1]!;
    const name = match[2]!;
    const direction = match[3] as 'up' | 'down';
    const group = groups.get(id) ?? { name };
    if (group.name !== name || group[direction] !== undefined) {
      throw new Error(`Duplicate migration version: ${id}`);
    }
    const sql = await readFile(join(directory, file.name), 'utf8');
    if (!sql.trim()) {
      throw new Error(`Empty migration: ${file.name}`);
    }
    // The filename/header opts into native pg_dump SQL, including SQL-standard
    // function bodies our guard cannot parse. This is an explicit trust convention,
    // not proof of provenance: baseline SQL must be reviewed before execution.
    if (!(file.name === '0001_baseline.up.sql' && sql.startsWith(baselineHeader))) {
      validateMigrationSql(sql, file.name);
    }
    group[direction] = sql;
    groups.set(id, group);
  }
  const sorted = [...groups].sort(([left], [right]) => {
    const a = BigInt(left);
    const b = BigInt(right);
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
    return 0;
  });
  return sorted.map(([id, group], i) => {
    if (i && BigInt(sorted[i - 1]![0]) === BigInt(id)) {
      throw new Error(`Duplicate migration version: ${id}`);
    }
    if (group.up === undefined) {
      throw new Error(`Migration ${id} has a down file without an up file.`);
    }
    return {
      id,
      name: group.name,
      up: group.up,
      ...(group.down === undefined ? {} : { down: group.down }),
      checksum: createHash('sha256')
        .update(JSON.stringify([group.up, group.down ?? null]))
        .digest('hex'),
    };
  });
}
