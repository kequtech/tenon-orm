import {
  Pool,
  type Client,
  type PoolClient,
  type PoolConfig,
  type QueryConfig,
  type QueryResult as PgResult,
} from 'pg';
import type { UnknownRow } from './query.js';
import { plainObject } from './validation.js';

export type ConnectionOptions = PoolConfig;
export type Connection = string | ConnectionOptions | Pool;
export type QueryResult<Row extends object = UnknownRow> = PgResult<Row>;
export type QueryExecutor = <T>(
  text: string,
  input: readonly unknown[],
  readResult: (result: QueryResult) => T,
  guarded: boolean,
) => Promise<T>;

/** A supplied pool may come from another installed copy of pg. */
function isPool(connection: Connection): connection is Pool {
  return (
    connection !== null &&
    typeof connection === 'object' &&
    'connect' in connection &&
    typeof connection.connect === 'function' &&
    'query' in connection &&
    typeof connection.query === 'function' &&
    'totalCount' in connection &&
    typeof connection.totalCount === 'number' &&
    'end' in connection &&
    typeof connection.end === 'function'
  );
}

/** Own constructed pools; supplied pools retain their application's ownership and error policy. */
export function createConnection(connection: Connection): {
  pool: Pool;
  run<T>(work: () => Promise<T>): Promise<T>;
  close(timeoutMs: number): Promise<void>;
} {
  if (isPool(connection)) return { pool: connection, run: (work) => work(), close: async () => {} };
  let config: PoolConfig;
  if (typeof connection === 'string') {
    if (!connection.trim()) throw new Error('Connection string must not be empty.');
    config = { connectionString: connection };
  } else {
    plainObject(connection, 'Connection configuration');
    if ('url' in connection) {
      throw new Error(
        'Use pg connectionString in the connection configuration instead of url/options.',
      );
    }
    config = connection;
  }
  const pool = new Pool(config);
  const clients = new Set<Client>();
  const pending = new Map<Promise<unknown>, (error: Error) => void>();
  let terminating = false;
  const terminate = (client: Client) => {
    void client.end().catch(() => {});
  };
  // pool.end handles idle clients; the deadline also ends native checkouts.
  pool.on('acquire', (client: Client) => {
    clients.add(client);
    if (terminating) terminate(client);
  });
  pool.on('release', (_error: Error | undefined, client: Client) => clients.delete(client));
  pool.on('error', (error: Error) => process.emitWarning(error));
  return {
    pool,
    run<T>(work: () => Promise<T>): Promise<T> {
      let expire!: (error: Error) => void;
      const task = new Promise<T>((resolve, reject) => {
        expire = reject;
        void Promise.resolve().then(work).then(resolve, reject);
      });
      pending.set(task, expire);
      const forget = () => {
        pending.delete(task);
      };
      void task.then(forget, forget);
      return task;
    },
    async close(timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ending: Promise<void> | undefined;
      const end = () => (ending ??= pool.end());
      try {
        await Promise.race([
          (async () => {
            await Promise.allSettled([...pending.keys()]);
            await end();
          })(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }).then(async () => {
            // Native callbacks must reject close on failure, not escape a timer callback.
            terminating = true;
            const error = new Error('The database shutdown deadline expired.');
            for (const reject of pending.values()) reject(error);
            try {
              void end().catch(() => {});
            } finally {
              // Attempt every checkout even when one native end call throws.
              await Promise.all([...clients].map(async (client) => terminate(client)));
            }
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** A checked-out pg client remains tied to its session and is discarded after a failure. */
export function watchClient(client: PoolClient) {
  let failure: Error | undefined;
  const onError = (error: Error) => {
    failure ??= error;
  };
  const onEnd = () => {
    failure ??= new Error('The PostgreSQL connection closed.');
  };
  client.on('error', onError);
  client.on('end', onEnd);
  return {
    check() {
      if (failure) throw failure;
    },
    release(error?: Error) {
      try {
        client.release(error ?? failure);
      } finally {
        client.removeListener('error', onError);
        client.removeListener('end', onEnd);
      }
    },
  };
}

/** Unnamed extended protocol enforces a single statement, even without parameters. */
export function executeSql(
  connection: Pool | PoolClient,
  text: string,
  input: readonly unknown[] = [],
) {
  const config: QueryConfig & { queryMode: 'extended' } = {
    text,
    values: [...input],
    queryMode: 'extended',
  };
  return connection.query<UnknownRow>(config);
}
