import { createClient } from './client.js';
import type { Connection, QueryExecutor } from './connection.js';
import { createConnection, executeSql } from './connection.js';
import { prepareArrays } from './driver/array.js';
import { guardListenerShutdown } from './driver/listener.js';
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
  const { sql: pool, owned } = createConnection(options.connection);
  const stopListeners = owned ? guardListenerShutdown(pool) : undefined;
  let closing: Promise<void> | undefined;

  function checkOpen() {
    if (closing) {
      throw new Error('This database instance is closed.');
    }
  }

  const query: QueryExecutor = async (text, input, readResult, guarded) => {
    checkOpen();
    if (guarded) {
      return withTransaction(pool, (query) => query(text, input, readResult, false));
    }
    await prepareArrays(pool);
    return readResult(await executeSql(pool, text, input));
  };

  return {
    ...createClient(query, options.onQuery),
    native: pool,
    async transaction(callback) {
      checkOpen();
      return withTransaction(pool, (query) => callback(createClient(query, options.onQuery)));
    },
    close(options) {
      if (closing) return closing;
      try {
        const timeoutMs = closeTimeout(options);
        // Cache before invoking driver callbacks, so reentrant/concurrent callers share shutdown.
        closing = Promise.resolve().then(() => {
          if (owned) {
            stopListeners!();
            return pool.end({ timeout: timeoutMs / 1000 });
          }
        });
        return closing;
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}
