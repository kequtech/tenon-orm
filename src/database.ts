import { createClient } from './client.js';
import type { Connection, QueryExecutor } from './connection.js';
import { createPool, executeSql } from './connection.js';
import { TenonError } from './errors.js';
import { withTransaction } from './transaction.js';
import type { Database, QueryEvent } from './types.js';
import { plainObject } from './validation.js';

export interface TenonOptions {
  readonly connection: Connection;
  readonly onQuery?: (event: QueryEvent) => void | Promise<void>;
}

export function createTenon(options: TenonOptions): Database {
  for (const key of Object.keys(plainObject(options, 'Tenon options'))) {
    if (key !== 'connection' && key !== 'onQuery') {
      throw new TenonError(`Unknown Tenon option: ${key}`);
    }
  }

  if (options.onQuery !== undefined && typeof options.onQuery !== 'function') {
    throw new TenonError('onQuery must be a function.');
  }
  const { pool, owned } = createPool(options.connection);
  let closed = false;

  function checkOpen() {
    if (closed) {
      throw new TenonError('This database instance is closed.');
    }
  }

  const query: QueryExecutor = async (text, input, readResult, guarded) => {
    checkOpen();
    if (guarded) {
      return withTransaction(pool, (query) => query(text, input, readResult, false));
    }
    return readResult(await executeSql(pool, text, input));
  };

  return {
    ...createClient(query, options.onQuery),
    async transaction(callback) {
      checkOpen();
      return withTransaction(pool, (query) => callback(createClient(query, options.onQuery)));
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      if (owned) {
        await pool.end();
      }
    },
  };
}
