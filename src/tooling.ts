import { Pool } from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import { validateName } from './sql.js';

export interface DatabaseToolOptions {
  readonly connection: string | PoolConfig | Pool;
  readonly namespace?: string;
  readonly directory?: string;
}
export const migrationTable = '__tenon_migrations';

/** Tool connections and advisory locks are independent of application sessions. */
export async function withToolConnection<T>(options: DatabaseToolOptions, shared: boolean,
  work: (client: PoolClient, namespace: string) => Promise<T>,
): Promise<T> {
  const namespace = options.namespace ?? 'public';
  validateName(namespace);
  const owned = !(options.connection instanceof Pool);
  const pool = options.connection instanceof Pool ? options.connection : new Pool(typeof options.connection === 'string' ? { connectionString: options.connection } : options.connection);
  let client: PoolClient | undefined;
  let locked = false;
  let failed = false;
  let error: unknown;
  let result!: T;
  let releaseError: Error | undefined;
  const lockKey = `tenon:migrations:${namespace}`;
  try {
    client = await pool.connect();
    // PostgreSQL owns the wait and honors this connection's lock_timeout.
    await client.query(`SELECT pg_advisory_lock${shared ? '_shared' : ''}(hashtextextended($1, 0))`, [lockKey]);
    locked = true;
    result = await work(client, namespace);
  } catch (cause) { failed = true; error = cause; }
  finally {
    if (client) {
      try {
        await client.query('ROLLBACK');
        if (locked) await client.query(`SELECT pg_advisory_unlock${shared ? '_shared' : ''}(hashtextextended($1, 0))`, [lockKey]);
      } catch (cause) {
        releaseError = cause instanceof Error ? cause : new Error('Tool connection cleanup failed.');
        error = failed ? new AggregateError([error, cause], 'Database operation and cleanup failed.') : cause;
        failed = true;
      }
      client.release(releaseError);
    }
    if (owned) {
      try { await pool.end(); }
      catch (cause) {
        error = failed ? new AggregateError([error, cause], 'Database operation and pool shutdown failed.') : cause;
        failed = true;
      }
    }
  }
  if (failed) throw error;
  return result;
}
