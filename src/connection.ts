import postgres from 'postgres';
import type { UnknownRow } from './query.js';
import { plainObject } from './validation.js';

export type ConnectionOptions = postgres.Options<{}>;
export type Connection = string | ConnectionOptions | postgres.Sql;
export type QueryResult<Row extends object = UnknownRow> = postgres.RowList<Row[]>;

/** The driver operations shared by ordinary and reserved connections. */
export interface SqlConnection {
  unsafe<Rows extends object[] = UnknownRow[]>(
    text: string,
    input?: postgres.ParameterOrJSON<never>[],
    options?: postgres.UnsafeQueryOptions & { simple?: boolean },
  ): Promise<postgres.RowList<Rows>>;
  array: postgres.Sql['array'];
  typed: postgres.Sql['typed'];
}
export type QueryExecutor = <T>(
  text: string,
  input: readonly unknown[],
  readResult: (result: QueryResult) => T,
  guarded: boolean,
) => Promise<T>;

/** Own clients created from a URI/config; borrow explicitly supplied Postgres.js clients. */
export function createConnection(connection: Connection): { sql: postgres.Sql; owned: boolean } {
  if (typeof connection === 'function' && typeof connection.unsafe === 'function') {
    return { sql: connection, owned: false };
  }
  if (typeof connection === 'string') {
    if (!connection.trim()) throw new Error('Connection string must not be empty.');
    return { sql: postgres(connection), owned: true };
  }
  plainObject(connection, 'Connection configuration');
  return { sql: postgres(connection), owned: true };
}

export function executeSql(
  sql: SqlConnection,
  text: string,
  input: readonly unknown[] = [],
): Promise<QueryResult> {
  // Tenon compiles SQL separately from values; let PostgreSQL infer array/JSON types from the surrounding SQL.
  const values = input.map((value) => (Array.isArray(value) ? sql.typed(value, 0) : value));
  const options = { simple: false, prepare: false };
  return sql.unsafe<UnknownRow[]>(text, values as postgres.ParameterOrJSON<never>[], options);
}
