import type { QueryResult, QueryResultRow } from 'pg';
import type { QueryOptions, QueryOutput, QueryReturnMode } from './query-options.js';
import type { SqlQuery } from './query.js';

export interface QueryClient {
  query<Row extends QueryResultRow>(
    query: SqlQuery<Row>,
    options?: QueryOptions & { readonly returns?: 'native' },
  ): NoInfer<Promise<QueryResult<Row>>>;
  query<Row extends QueryResultRow, Mode extends QueryReturnMode>(
    query: SqlQuery<Row>,
    options: QueryOptions & { readonly returns: Mode },
  ): NoInfer<Promise<QueryOutput<Row, Mode>>>;
  query<Row extends QueryResultRow>(
    query: SqlQuery<Row>,
    options: QueryOptions | undefined,
  ): NoInfer<Promise<QueryOutput<Row, QueryReturnMode>>>;
}
export type Transaction = QueryClient;
export type Database = Transaction & {
  /** Await all work inside the callback. Commit on success; rollback on an escaping error. */
  transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** One completed public query call, including rollback/commit time for guarded calls. */
export interface QueryEvent {
  readonly label?: string;
  readonly durationMs: number;
  readonly outcome: 'success' | 'error';
  readonly command?: string;
  readonly rowCount?: number | null;
  /** Stable Tenon or PostgreSQL error code, when available. */
  readonly errorCode?: string;
}
