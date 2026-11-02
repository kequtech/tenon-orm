import {
  createPool,
  type Pool,
  type PoolOptions,
  type QueryResult as DriverResult,
  type Executor,
  type InputValue,
  type OperationOptions,
} from '@kequtech/pgclear';
import type { UnknownRow } from './query.js';
import { plainObject } from './validation.js';
import type { QueryOperation } from './query-operation.js';

export type ConnectionOptions = PoolOptions;
/** Connection settings and executable credentials/codecs, without a live pool. */
export type ConnectionConfig =
  | string
  | (Omit<ConnectionOptions, 'connectionString'> & {
      /** May be absent during builds; operations reject an explicitly missing URI. */
      readonly connectionString?: string | undefined;
      readonly acquire?: never;
      readonly close?: never;
    });
export type Connection = string | ConnectionOptions | Pool;
export type QueryResult<Row extends object = UnknownRow> = DriverResult<Row>;
export type QueryExecutor = <T>(
  text: string,
  input: readonly unknown[],
  readResult: (result: QueryResult) => T,
  guarded: boolean,
  operation?: QueryOperation,
) => Promise<T>;

export function isPool(connection: unknown): connection is Pool {
  return (
    connection !== null &&
    typeof connection === 'object' &&
    'acquire' in connection &&
    typeof connection.acquire === 'function' &&
    'close' in connection &&
    typeof connection.close === 'function' &&
    'stats' in connection
  );
}
/** Constructed pools are owned; supplied public pgclear pools remain application-owned. */
export function createConnection(connection: Connection): {
  pool: Pool;
  close(timeoutMs: number): Promise<void>;
} {
  if (isPool(connection)) return { pool: connection, close: async () => {} };
  if (typeof connection !== 'string') plainObject(connection, 'Connection configuration');
  const pool = createPool(connection);
  return { pool, close: (timeoutMs) => pool.close({ timeoutMs }) };
}
export function executeSql(
  connection: Executor,
  text: string,
  input: readonly unknown[] = [],
  options?: OperationOptions,
): Promise<QueryResult> {
  return connection.queryClassic(text, input as readonly InputValue[], options);
}
