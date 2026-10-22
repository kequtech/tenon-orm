import type { PoolClient, PoolConfig, QueryResult } from 'pg';
import { Pool } from 'pg';

export type Connection = string | PoolConfig | Pool;
export type QueryExecutor = <T>(
  text: string,
  input: readonly unknown[],
  readResult: (result: QueryResult<Record<string, unknown>>) => T,
  guarded: boolean,
) => Promise<T>;

/** Borrow application pools; own pools created from a connection string or config. */
export function createPool(connection: Connection): { pool: Pool; owned: boolean } {
  if (connection instanceof Pool) {
    return { pool: connection, owned: false };
  }
  const config = typeof connection === 'string' ? { connectionString: connection } : connection;
  const pool = new Pool(config);
  // pg removes broken idle clients itself, but an unhandled pool error would
  // still terminate Node. Borrowed pools keep their application's error policy.
  pool.on('error', (error) => process.emitWarning(error));
  return { pool, owned: true };
}

/** Observe failures between queries until ownership returns to the pool. */
export function watchClient(client: PoolClient) {
  let failure: Error | undefined;
  const onError = (error: Error) => {
    failure ??= error;
  };
  client.on('error', onError);
  return {
    check() {
      if (failure) {
        throw failure;
      }
    },
    release(error?: Error) {
      try {
        client.release(error ?? failure);
      } finally {
        client.removeListener('error', onError);
      }
    },
  };
}

export function executeSql(connection: Pool | PoolClient, text: string, input: readonly unknown[]) {
  // Extended protocol makes even a zero-parameter call one SQL statement.
  const config = { text, values: [...input], queryMode: 'extended' };
  return connection.query<Record<string, unknown>>(config);
}
