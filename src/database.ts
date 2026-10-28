import { createClient } from './client.js';
import type { Connection, QueryExecutor } from './connection.js';
import { createConnection, executeSql } from './connection.js';
import { withTransaction } from './transaction.js';
import type { CloseOptions, Database, QueryEvent } from './types.js';
import { plainObject } from './validation.js';

export interface TenonOptions {
  readonly connection: Connection;
  readonly onQuery?: (event: QueryEvent) => void | Promise<void>;
}

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

export function createTenon(options: TenonOptions): Database {
  for (const key of Object.keys(plainObject(options, 'Tenon options'))) {
    if (key !== 'connection' && key !== 'onQuery') {
      throw new Error(`Unknown Tenon option: ${key}`);
    }
  }

  if (options.onQuery !== undefined && typeof options.onQuery !== 'function') {
    throw new Error('onQuery must be a function.');
  }
  const { pool, run, close } = createConnection(options.connection);
  let closing: Promise<void> | undefined;

  function checkOpen() {
    if (closing) {
      throw new Error('This database instance is closed.');
    }
  }

  const query: QueryExecutor = (text, input, readResult, guarded) => {
    checkOpen();
    return run(async () => {
      if (guarded) {
        return withTransaction(pool, (query) => query(text, input, readResult, false));
      }
      return readResult(await executeSql(pool, text, input));
    });
  };

  return {
    ...createClient(query, options.onQuery),
    native: pool,
    async transaction(callback) {
      checkOpen();
      return run(() =>
        withTransaction(pool, (query) => callback(createClient(query, options.onQuery))),
      );
    },
    close(options) {
      if (closing) return closing;
      try {
        const timeoutMs = closeTimeout(options);
        // Cache before invoking driver callbacks, so reentrant/concurrent callers share shutdown.
        closing = Promise.resolve().then(() => close(timeoutMs));
        return closing;
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}
