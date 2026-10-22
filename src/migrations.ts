import { TenonError } from './errors.js';
import type { DatabaseToolOptions } from './migrations/connection.js';
import { withMigrationLock } from './migrations/connection.js';
import { readMigrations } from './migrations/files.js';
import {
  createHistoryTable,
  migrationState,
  migrationTable,
  recordMigration,
} from './migrations/history.js';
import { qualified, quote } from './sql.js';

export interface MigrationStatus {
  readonly applied: readonly string[];
  readonly pending: readonly string[];
}

export async function migrationStatus(options: DatabaseToolOptions): Promise<MigrationStatus> {
  const files = await readMigrations(options.directory);
  return withMigrationLock(options, 'shared', async (client, namespace) => {
    const applied = await migrationState(client, namespace, files);
    return {
      applied: applied.map((m) => m.id),
      pending: files.slice(applied.length).map((m) => m.id),
    };
  });
}

async function execute(
  options: DatabaseToolOptions,
  direction: 'up' | 'down',
  steps: number,
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(steps) || steps < 1) {
    throw new TenonError('Rollback steps must be a positive safe integer.');
  }
  const files = await readMigrations(options.directory);
  return withMigrationLock(options, 'exclusive', async (client, namespace) => {
    const applied = await migrationState(client, namespace, files);
    const selected =
      direction === 'up'
        ? files.slice(applied.length)
        : files.slice(Math.max(0, applied.length - steps), applied.length).reverse();
    if (direction === 'down' && selected.some((file) => file.down === undefined)) {
      throw new TenonError('A selected migration has no down SQL and cannot be rolled back.');
    }
    if (!selected.length) {
      return [];
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(namespace)}`);
    await createHistoryTable(client, namespace);
    const completed: string[] = [];
    for (const file of selected) {
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path TO ${quote(namespace)}, pg_catalog`);
        await client.query(direction === 'up' ? file.up : file.down!);
        if (direction === 'up') {
          await recordMigration(client, namespace, file);
        } else {
          await client.query(`DELETE FROM ${qualified(namespace, migrationTable)} WHERE id = $1`, [
            file.id,
          ]);
        }
        const result = await client.query('COMMIT');
        if (result.command !== 'COMMIT') {
          throw new TenonError('The migration transaction was rolled back.');
        }
        completed.push(file.id);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : 'Unknown database error';
        throw new TenonError(
          `Migration ${file.id}_${file.name} (${direction}) failed: ${reason}. Earlier migrations in this run may have committed.`,
          { cause },
        );
      }
    }
    return completed;
  });
}

export function migrate(options: DatabaseToolOptions): Promise<readonly string[]> {
  return execute(options, 'up', 1);
}
export function rollback(
  options: DatabaseToolOptions & { readonly steps?: number },
): Promise<readonly string[]> {
  return execute(options, 'down', options.steps ?? 1);
}
