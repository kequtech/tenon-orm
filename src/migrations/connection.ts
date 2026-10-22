import type { PoolClient } from 'pg';
import type { Connection } from '../connection.js';
import { createPool, watchClient } from '../connection.js';
import { validateName } from '../sql.js';

export interface DatabaseToolOptions {
  readonly connection: Connection;
  readonly namespace?: string;
  readonly directory?: string;
}

/** Coordinate tools independently of application sessions; PostgreSQL owns the wait. */
export async function withMigrationLock<T>(
  options: DatabaseToolOptions,
  mode: 'shared' | 'exclusive',
  work: (client: PoolClient, namespace: string) => Promise<T>,
): Promise<T> {
  const namespace = options.namespace ?? 'public';
  validateName(namespace);
  const { pool, owned } = createPool(options.connection);
  const suffix = mode === 'shared' ? '_shared' : '';
  const lockKey = `tenon:migrations:${namespace}`;
  const errors: unknown[] = [];
  let client: PoolClient | undefined;
  let connection: ReturnType<typeof watchClient> | undefined;
  let locked = false;
  let result!: T;

  try {
    client = await pool.connect();
    connection = watchClient(client);
    await client.query(`SELECT pg_advisory_lock${suffix}(hashtextextended($1, 0))`, [lockKey]);
    locked = true;
    result = await work(client, namespace);
    connection.check();
  } catch (error) {
    errors.push(error);
  } finally {
    if (client) {
      let releaseError: Error | undefined;
      try {
        await client.query('ROLLBACK');
        if (locked) {
          await client.query(`SELECT pg_advisory_unlock${suffix}(hashtextextended($1, 0))`, [
            lockKey,
          ]);
        }
      } catch (error) {
        errors.push(error);
        releaseError =
          error instanceof Error ? error : new Error('Tool connection cleanup failed.');
      }
      try {
        connection!.release(releaseError);
      } catch (error) {
        errors.push(error);
      }
    }
    if (owned) {
      try {
        await pool.end();
      } catch (error) {
        errors.push(error);
      }
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Database operation and cleanup failed.');
  }
  return result;
}
