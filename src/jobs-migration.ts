import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jobsMigration } from '@kequtech/pgclear-jobs/migrations';
import { withMigrationCreationLock, writeMigrationPair } from './migrations/files.js';
import type { CreatedMigration } from './migrations/files.js';
import { validateMigrationSql } from './migrations/sql.js';

export interface CreateJobsMigrationOptions {
  readonly directory?: string;
}
export interface CreatedJobsMigration extends CreatedMigration {
  readonly created: boolean;
}

// Stable identity across dependency updates; historical SQL is never compared with the package.
const marker = '-- Tenon Jobs setup (@kequtech/pgclear-jobs)';

/** Generate concrete SQL offline. Applying it is the application's normal migration operation. */
export function createJobsMigration(
  options: CreateJobsMigrationOptions = {},
): Promise<CreatedJobsMigration> {
  return withMigrationCreationLock(options.directory ?? 'migrations', async (directory) => {
    const existing = new Map<string, { id: string; upPath?: string; downPath?: string }>();
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const match = /^(\d+)_([A-Za-z0-9_-]+)\.(up|down)\.sql$/.exec(file.name);
      if (!match) continue;
      const path = join(directory, file.name);
      const sql = await readFile(path, 'utf8');
      const newline = sql.indexOf('\n');
      // Editors/checkouts may add a BOM, CRLF or trailing whitespace; preserve the saved bytes.
      const generated = (newline < 0 ? sql : sql.slice(0, newline)).trim() === marker;
      if (match[2] !== 'pgclear_jobs' && !generated) continue;
      if (!generated || newline < 0 || !sql.slice(newline + 1).trim()) {
        throw new Error(
          `Incomplete or conflicting Jobs migration: ${path}. Restore or review it before setup.`,
        );
      }
      validateMigrationSql(sql, file.name);
      const key = `${match[1]}_${match[2]}`;
      const pair = existing.get(key) ?? { id: match[1]! };
      if (match[3] === 'up') pair.upPath = path;
      else pair.downPath = path;
      existing.set(key, pair);
    }
    if (existing.size > 1)
      throw new Error('Multiple Jobs setup migrations found. Review the existing files.');
    const pair = [...existing.values()][0];
    if (pair) {
      if (!pair.upPath || !pair.downPath)
        throw new Error('Incomplete Jobs migration pair. Restore the missing file before setup.');
      return { id: pair.id, upPath: pair.upPath, downPath: pair.downPath, created: false };
    }
    const sql = { up: marker + '\n' + jobsMigration.up, down: marker + '\n' + jobsMigration.down };
    validateMigrationSql(sql.up, 'pgclear_jobs.up.sql');
    validateMigrationSql(sql.down, 'pgclear_jobs.down.sql');
    return { ...(await writeMigrationPair(directory, 'pgclear_jobs', sql)), created: true };
  });
}
