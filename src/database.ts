import { createClient } from './client.js';
import type { QueryExecutor } from './connection.js';
import { createConnection, executeSql, isPool } from './connection.js';
import type { TenonConfig } from './config.js';
import { configConnection } from './config/connection.js';
import { configObject } from './config/validate.js';
import { withTransaction } from './transaction.js';
import type { CloseOptions, Database } from './types.js';
import { plainObject } from './validation.js';

function closeTimeout(options: CloseOptions | undefined): number {
  const settings = plainObject(options === undefined ? {} : options, 'Close options');
  for (const key of Object.keys(settings)) {
    if (key !== 'timeoutMs') throw new Error(`Unknown close option: ${key}`);
  }
  const timeoutMs = settings.timeoutMs === undefined ? 5000 : settings.timeoutMs;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 2147483647
  ) {
    throw new Error('Close timeoutMs must be an integer from 0 to 2147483647 milliseconds.');
  }
  return timeoutMs;
}

export function createTenon(config: TenonConfig): Database {
  configObject(config);
  const onQuery = config.onQuery;
  let connection: ReturnType<typeof createConnection> | undefined;
  let closing: Promise<void> | undefined;

  function checkOpen() {
    if (closing) {
      throw new Error('This database instance is closed.');
    }
  }

  function currentConnection() {
    if (!connection) {
      checkOpen();
      const value = config.connection;
      connection = createConnection(isPool(value) ? value : configConnection(value));
    }
    return connection;
  }

  const query: QueryExecutor = (text, input, readResult, guarded) => {
    checkOpen();
    const { pool } = currentConnection();
    if (guarded) return withTransaction(pool, (query) => query(text, input, readResult, false));
    return executeSql(pool, text, input).then(readResult);
  };

  return {
    ...createClient(query, onQuery),
    get native() {
      return currentConnection().pool;
    },
    async transaction(callback) {
      checkOpen();
      const { pool } = currentConnection();
      return withTransaction(pool, (query) => callback(createClient(query, onQuery)));
    },
    close(options) {
      if (closing) return closing;
      try {
        const timeoutMs = closeTimeout(options);
        // Cache before invoking driver callbacks, so reentrant/concurrent callers share shutdown.
        closing = Promise.resolve().then(() => connection?.close(timeoutMs));
        return closing;
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}
