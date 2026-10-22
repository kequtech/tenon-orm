import type { QueryResult, QueryResultRow } from 'pg';
import type {
  OperationDefinition,
  OperationOptions,
  OperationResult,
  OperationReturnMode,
} from './operations.js';
import type { SqlQuery } from './query.js';

export interface QueryClient {
  query<Row extends QueryResultRow>(
    query: SqlQuery<Row>,
    options?: OperationOptions & { readonly returns?: 'native' },
  ): NoInfer<Promise<QueryResult<Row>>>;
  query<Row extends QueryResultRow, Mode extends OperationReturnMode>(
    query: SqlQuery<Row>,
    options: OperationOptions & { readonly returns: Mode },
  ): NoInfer<Promise<OperationResult<Row, Mode>>>;
  query<Row extends QueryResultRow>(
    query: SqlQuery<Row>,
    options: OperationOptions | undefined,
  ): NoInfer<Promise<OperationResult<Row, OperationReturnMode>>>;
  run<
    Input extends readonly unknown[],
    Row extends QueryResultRow,
    Mode extends OperationReturnMode,
  >(
    operation: OperationDefinition<Input, Row, Mode>,
    input: NoInfer<Readonly<Input>>,
  ): NoInfer<Promise<OperationResult<Row, Mode>>>;
}
export type Transaction = QueryClient;
export type Database = Transaction & {
  /** Await all work inside the callback. Commit on success; rollback on an escaping error. */
  transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** One completed public query/run call, including rollback/commit time for guarded calls. */
export interface QueryEvent {
  readonly label?: string;
  readonly durationMs: number;
  readonly outcome: 'success' | 'error';
  readonly command?: string;
  readonly rowCount?: number | null;
  /** Stable Tenon or PostgreSQL error code, when available. */
  readonly errorCode?: string;
}
