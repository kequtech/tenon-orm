import { createClient } from './client.js';
import type { Connection, QueryExecutor } from './connection.js';
import { createPool, executeSql } from './connection.js';
import { TenonError } from './errors.js';
import type { EmptyOperations, OperationRegistry } from './operations.js';
import { inspectOperations } from './operations.js';
import { withTransaction } from './transaction.js';
import type { Database } from './types.js';
import { plainObject } from './validation.js';

export interface TenonOptions<O extends OperationRegistry = EmptyOperations> {
  readonly connection: Connection;
  readonly operations?: O;
}

export default function tenon<const O extends OperationRegistry = EmptyOperations>(
  options: TenonOptions<O>,
): Database<O> {
  for (const key of Object.keys(plainObject(options, 'Tenon options'))) {
    if (key !== 'connection' && key !== 'operations') {
      throw new TenonError(`Unknown Tenon option: ${key}`);
    }
  }

  const operations = inspectOperations(options.operations ?? {});
  const { pool, owned } = createPool(options.connection);
  let closed = false;

  function checkOpen() {
    if (closed) {
      throw new TenonError('This database instance is closed.');
    }
  }

  const query: QueryExecutor = async (text, input) => {
    checkOpen();
    return executeSql(pool, text, input);
  };

  return {
    ...createClient<O>(operations, query),
    async transaction(callback) {
      checkOpen();
      return withTransaction(pool, (query) => callback(createClient<O>(operations, query)));
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
