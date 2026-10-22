import type { Pool } from 'pg';
import type { QueryExecutor } from './connection.js';
import { executeSql } from './connection.js';
import { TenonError } from './errors.js';

/** The callback owns one connection and expires before commit or rollback begins. */
export async function withTransaction<T>(
  pool: Pool,
  work: (query: QueryExecutor) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let active = true;
  let releaseError: Error | undefined;
  const query: QueryExecutor = async (text, input) => {
    if (!active) {
      throw new TenonError('The transaction has finished.');
    }
    return executeSql(client, text, input);
  };

  try {
    await client.query('BEGIN');
    const result = await work(query);
    active = false;
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') {
      throw new TenonError('PostgreSQL rolled back the aborted transaction.');
    }
    return result;
  } catch (error) {
    active = false;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      releaseError = rollbackError instanceof Error ? rollbackError : new Error('Rollback failed.');
      throw new AggregateError([error, rollbackError], 'Transaction and rollback failed.');
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
