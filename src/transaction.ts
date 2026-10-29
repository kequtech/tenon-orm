import type { Pool, Transaction } from '@kequtech/pgclear';
import type { QueryExecutor, QueryResult } from './connection.js';
import { executeSql } from './connection.js';

/** Serialize whole Tenon policies; pgclear owns transaction, savepoint and transport recovery. */
export function withTransaction<T>(
  pool: Pool,
  work: (query: QueryExecutor) => Promise<T>,
): Promise<T> {
  return pool.transaction(async (transaction) => {
    let active = true;
    let pending: Promise<void> = Promise.resolve();
    const query: QueryExecutor = <R>(
      text: string,
      input: readonly unknown[],
      readResult: (result: QueryResult) => R,
      guarded: boolean,
    ): Promise<R> => {
      if (!active) return Promise.reject(new Error('The transaction has finished.'));
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
      return await work(query);
    } finally {
      active = false;
      await pending;
    }
  });
}
