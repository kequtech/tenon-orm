import type { PoolClient, PoolConfig, QueryResult } from 'pg';
import { Pool } from 'pg';

export type Connection = string | PoolConfig | Pool;
export type QueryExecutor = (
  text: string,
  input: readonly unknown[],
) => Promise<QueryResult<Record<string, unknown>>>;

/** Borrow application pools; own pools created from a connection string or config. */
export function createPool(connection: Connection): { pool: Pool; owned: boolean } {
  if (connection instanceof Pool) {
    return { pool: connection, owned: false };
  }
  const config = typeof connection === 'string' ? { connectionString: connection } : connection;
  return { pool: new Pool(config), owned: true };
}

export function executeSql(connection: Pool | PoolClient, text: string, input: readonly unknown[]) {
  // Extended protocol makes even a zero-parameter call one SQL statement.
  const config = { text, values: [...input], queryMode: 'extended' };
  return connection.query<Record<string, unknown>>(config);
}
