import { defaultCodecs, type Lease, type Session } from '@kequtech/pgclear';
import type { Connection } from '../connection.js';
import { createConnection } from '../connection.js';

import { validateName } from '../sql.js';

export interface DatabaseToolOptions {
  readonly connection: Connection;
  readonly namespace?: string;
  readonly directory?: string;
}

/** Hold one session advisory lock while tooling runs, restoring transactions before release. */
export async function withMigrationLock<T>(
  options: DatabaseToolOptions,
  mode: 'shared' | 'exclusive',
  work: (client: Session, namespace: string) => Promise<T>,
): Promise<T> {
  const namespace = options.namespace ?? 'public';
  validateName(namespace);
  const { pool, close } = createConnection(options.connection);
  const suffix = mode === 'shared' ? '_shared' : '';
  const lockKey = `tenon:migrations:${namespace}`;
  const errors: unknown[] = [];
  let lease: Lease | undefined;
  let locked = false;
  let result!: T;
  try {
    lease = await pool.acquire();
    const client = lease;
    await client.queryClassic(
      `SELECT pg_advisory_lock${suffix}(hashtextextended($1, 0))`,
      [lockKey],
      { codecs: defaultCodecs },
    );
    locked = true;
    result = await work(client, namespace);
  } catch (error) {
    errors.push(error);
  } finally {
    if (lease) {
      const client = lease;
      try {
        if (lease.transactionStatus !== 'idle') await client.queryClassic('ROLLBACK', []);
        if (locked) {
          await client.queryClassic(
            `SELECT pg_advisory_unlock${suffix}(hashtextextended($1, 0))`,
            [lockKey],
            { codecs: defaultCodecs },
          );
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        await lease.release({ discard: errors.length > 0 });
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await close(1000);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Database operation and cleanup failed.');
  }
  return result;
}
