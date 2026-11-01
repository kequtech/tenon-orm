import type { Pool, Transaction, TransactionOptions } from '@kequtech/pgclear';
import type { QueryExecutor, QueryResult } from './connection.js';
import { executeSql } from './connection.js';

/** Serialize whole Tenon policies; pgclear owns transaction, savepoint and transport recovery. */
export function withTransaction<T>(
  pool: Pool,
  work: (query: QueryExecutor, checkActive: () => void) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  let active = true;
  function checkActive() {
    if (!active) throw new Error('The transaction has finished.');
  }
  return pool
    .transaction(async (transaction) => {
      let pending: Promise<void> = Promise.resolve();
      const query: QueryExecutor = <R>(
        text: string,
        input: readonly unknown[],
        readResult: (result: QueryResult) => R,
        guarded: boolean,
      ): Promise<R> => {
        try {
          checkActive();
        } catch (error) {
          return Promise.reject(error);
        }
        const operation = pending.then(() => {
          const execute = async (scope: Transaction) =>
            readResult(await executeSql(scope, text, input));
          return guarded ? transaction.savepoint(execute) : execute(transaction);
        });
        pending = operation.then(
          () => {},
          () => {},
        );
        return operation;
      };
      try {
        return await work(query, checkActive);
      } finally {
        active = false;
        await pending;
      }
    }, options)
    .finally(() => {
      // pgclear can finish cancellation while user JavaScript is still suspended in work().
      active = false;
    });
}
