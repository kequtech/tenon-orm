import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { DatabaseToolOptions } from '../../src/index.js';
import { quote } from '../../src/sql.js';

const testDatabaseUrl = new URL(
  process.env.TENON_TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/tenon_orm_test',
);
// Quiet fixture setup/cleanup notices, including CLI children; retain warnings and errors.
testDatabaseUrl.searchParams.set(
  'options',
  `${testDatabaseUrl.searchParams.get('options') ?? ''} -c client_min_messages=warning`.trim(),
);
// libpq clients such as pg_dump require URI spaces (%20), rather than form spaces (+).
testDatabaseUrl.search = testDatabaseUrl.searchParams.toString().replaceAll('+', '%20');
export const testConnection = testDatabaseUrl.toString();

/** Check before a test creates or changes any namespace. */
export async function assertTestDatabase(pool: Pool): Promise<string> {
  const result = (
    await pool.query<{ name: string; version: string; version_num: number }>(`
    SELECT current_database() AS name, current_setting('server_version') AS version,
      current_setting('server_version_num')::integer AS version_num
  `)
  ).rows;
  const database = result[0]!;
  if (database.name !== 'tenon_orm_test') {
    throw new Error('Tests require the tenon_orm_test database. No test schemas were changed.');
  }
  if (database.version_num < 160000) {
    throw new Error(
      `Tests require PostgreSQL 16 or newer; connected to ${database.version}. Upgrade the test server or set TENON_TEST_DATABASE_URL to a supported tenon_orm_test database. No test schemas were changed.`,
    );
  }
  return database.version;
}

export interface MigrationProject extends DatabaseToolOptions {
  namespace: string;
  directory: string;
}

/** Each test owns its migration files and namespace, including failure cleanup. */
export function migrationProject(pool: Pool) {
  return async (
    files: Readonly<Record<string, string>>,
    work: (options: MigrationProject) => Promise<void>,
  ): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'tenon-migrations-'));
    const namespace = `tenon_test_${randomUUID().replaceAll('-', '')}`;
    try {
      for (const [name, sql] of Object.entries(files)) await writeFile(join(directory, name), sql);
      await work({ connection: pool, namespace, directory });
    } finally {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${quote(namespace)} CASCADE`);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
}

/** Fixture setup that must use one PostgreSQL transaction. */
export async function fixtureTransaction<T>(
  pool: Pool,
  work: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
