import type { Pool, TransactionOptions } from '@kequtech/pgclear';
import type { DatabaseJobs, TransactionJobs } from './jobs.js';
import type { QueryResult } from './connection.js';
import type { QueryOptions, QueryOutput, QueryReturnMode } from './query-options.js';
import type { SqlQuery } from './query.js';

export interface QueryClient {
  query<Row extends object>(
    query: SqlQuery<Row>,
    options?: QueryOptions & { readonly returns?: 'native' },
  ): NoInfer<Promise<QueryResult<Row>>>;
  query<Row extends object, Mode extends QueryReturnMode>(
    query: SqlQuery<Row>,
    options: QueryOptions & { readonly returns: Mode },
  ): NoInfer<Promise<QueryOutput<Row, Mode>>>;
  query<Row extends object>(
    query: SqlQuery<Row>,
    options: QueryOptions | undefined,
  ): NoInfer<Promise<QueryOutput<Row, QueryReturnMode>>>;
}
export interface Transaction extends QueryClient {
  readonly jobs: TransactionJobs;
}
export interface CloseOptions {
  /** Grace period before requesting owned driver termination; milliseconds, default 5000. */
  readonly timeoutMs?: number | undefined;
}
export type Database = Transaction & {
  readonly jobs: DatabaseJobs;
  /** The underlying pool; access initializes shared config. Native calls bypass Tenon's guards. */
  readonly native: Pool;
  /** Await all work inside the callback. Commit on success; rollback on an escaping error. */
  transaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  close(options?: CloseOptions): Promise<void>;
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
