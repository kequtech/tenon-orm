import type { PoolClient } from 'pg';
import { TenonError } from '../errors.js';
import { qualified } from '../sql.js';
import type { SqlMigration } from './files.js';

export const migrationTable = '__tenon_migrations';
interface AppliedMigration {
  id: string;
  name: string;
  checksum: string;
}

export async function migrationState(
  client: PoolClient,
  namespace: string,
  migrations: readonly SqlMigration[],
): Promise<readonly AppliedMigration[]> {
  const exists = await client.query<{ name: string | null }>(
    'SELECT to_regclass($1)::text AS name',
    [qualified(namespace, migrationTable)],
  );
  if (exists.rows[0]!.name === null) {
    return [];
  }
  const { rows: applied } = await client.query<AppliedMigration>(
    `SELECT id, name, checksum FROM ${qualified(namespace, migrationTable)} ORDER BY id::numeric`,
  );
  for (const [i, record] of applied.entries()) {
    const file = migrations[i];
    if (
      !file ||
      file.id !== record.id ||
      file.name !== record.name ||
      file.checksum !== record.checksum
    ) {
      throw new TenonError(
        `Migration history differs from files at version ${record.id}; restore applied files before continuing.`,
      );
    }
  }
  return applied;
}

export async function createHistoryTable(client: PoolClient, namespace: string): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${qualified(namespace, migrationTable)} (
      id TEXT PRIMARY KEY CHECK (id ~ '^[0-9]+$'),
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  );
}

export async function recordMigration(
  client: PoolClient,
  namespace: string,
  migration: SqlMigration,
): Promise<void> {
  await client.query(
    `INSERT INTO ${qualified(namespace, migrationTable)} (id, name, checksum) VALUES ($1, $2, $3)`,
    [migration.id, migration.name, migration.checksum],
  );
}
