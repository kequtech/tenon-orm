import type { QueryResult, QueryResultRow } from 'pg';
import type { EmptyOperations, OperationClient, OperationRegistry } from './operations.js';

export interface SqlClient {
  /** Row describes one SQL record; returns determines its surrounding result shape. */
  sql<Row extends QueryResultRow = never>(
    sql: string,
    input: readonly unknown[],
    options?: { readonly returns?: 'native' },
  ): NoInfer<Promise<QueryResult<Row>>>;
  sql<Row extends QueryResultRow = never>(
    sql: string,
    input: readonly unknown[],
    options: { readonly returns: 'many' },
  ): NoInfer<Promise<Row[]>>;
  sql<Row extends QueryResultRow = never>(
    sql: string,
    input: readonly unknown[],
    options: { readonly returns: 'one' },
  ): NoInfer<Promise<Row | undefined>>;
  sql<Row extends QueryResultRow = never>(
    sql: string,
    input: readonly unknown[],
    options: { readonly returns: 'requiredOne' },
  ): NoInfer<Promise<Row>>;
}
export type Transaction<O extends OperationRegistry = EmptyOperations> = SqlClient &
  OperationClient<O>;
export type Database<O extends OperationRegistry = EmptyOperations> = Transaction<O> & {
  /** One connection; commit on success and rollback on error. Await all tx work inside the callback. */
  transaction<T>(callback: (tx: Transaction<O>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};
