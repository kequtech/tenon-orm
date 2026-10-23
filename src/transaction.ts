import type { Pool } from 'pg';
import type { QueryExecutor } from './connection.js';
import { executeSql, watchClient } from './connection.js';

/** The callback owns one connection and expires before commit or rollback begins. */
export async function withTransaction<T>(
  pool: Pool,
  work: (query: QueryExecutor) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const connection = watchClient(client);
  let active = true;
  let releaseError: Error | undefined;
  let savepointId = 0;
  let pending: Promise<void> = Promise.resolve();
  let recoveryFailure: AggregateError | undefined;

  const query: QueryExecutor = async (text, input, readResult, guarded) => {
    if (!active) throw new Error('The transaction has finished.');

    // Queue whole operations, including savepoint cleanup. Otherwise concurrent
    // calls could place another write inside a savepoint that gets rolled back.
    const operation = pending.then(async () => {
      connection.check();
      if (recoveryFailure) throw recoveryFailure;
      if (!guarded) return readResult(await executeSql(client, text, input));

      const savepoint = `tenon_affected_rows_${++savepointId}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = readResult(await executeSql(client, text, input));
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (rollbackError) {
          // Even if application code catches this error, the outer transaction
          // must not commit when the rejected write could still be present.
          recoveryFailure = new AggregateError(
            [error, rollbackError],
            'Operation and savepoint recovery failed.',
          );
          throw recoveryFailure;
        }
        throw error;
      }
    });
    pending = operation.then(
      () => {},
      () => {},
    );
    return operation;
  };

  try {
    await client.query('BEGIN');
    const result = await work(query);
    active = false;
    await pending;
    connection.check();
    if (recoveryFailure) throw recoveryFailure;
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') {
      throw new Error('PostgreSQL rolled back the aborted transaction.');
    }
    return result;
  } catch (error) {
    active = false;
    await pending;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      releaseError = rollbackError instanceof Error ? rollbackError : new Error('Rollback failed.');
      throw new AggregateError([error, rollbackError], 'Transaction and rollback failed.');
    }
    throw error;
  } finally {
    connection.release(releaseError);
  }
}
