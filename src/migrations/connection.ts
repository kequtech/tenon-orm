import { reserveConnection } from '../driver/session.js';
import type { Connection, SqlConnection } from '../connection.js';
import { createConnection } from '../connection.js';
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
  work: (client: SqlConnection, namespace: string) => Promise<T>,
): Promise<T> {
  const namespace = options.namespace ?? 'public';
  validateName(namespace);
  const { sql: pool, owned } = createConnection(options.connection);
  const suffix = mode === 'shared' ? '_shared' : '';
  const lockKey = `tenon:migrations:${namespace}`;
  const errors: unknown[] = [];
  let connection: Awaited<ReturnType<typeof reserveConnection>> | undefined;
  let locked = false;
  let result!: T;

  try {
    connection = await reserveConnection(pool);
    const client = connection.sql;
    await client.unsafe(`SELECT pg_advisory_lock${suffix}(hashtextextended($1, 0))`, [lockKey]);
    locked = true;
    result = await work(client, namespace);
    connection.check();
  } catch (error) {
    errors.push(error);
  } finally {
    if (connection) {
      const client = connection.sql;
      let discard = false;
      try {
        connection.check();
        if (errors.length) await client.unsafe('ROLLBACK');
        if (locked) {
          await client.unsafe(`SELECT pg_advisory_unlock${suffix}(hashtextextended($1, 0))`, [
            lockKey,
          ]);
        }
      } catch (error) {
        errors.push(error);
        discard = true;
      }
      try {
        await connection.release(discard);
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
