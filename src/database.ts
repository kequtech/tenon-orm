import { createClient } from './client.js';
import type { Connection, QueryExecutor } from './connection.js';
import { createConnection, executeSql } from './connection.js';
import { prepareArrays } from './driver/array.js';
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
      throw new Error(`Unknown Tenon option: ${key}`);
    }
  }

  if (options.onQuery !== undefined && typeof options.onQuery !== 'function') {
    throw new Error('onQuery must be a function.');
  }
  const { sql: pool, owned } = createConnection(options.connection);
  let closed = false;

  function checkOpen() {
    if (closed) {
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
