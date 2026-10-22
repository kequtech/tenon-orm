import type { QueryExecutor } from './connection.js';
import { TenonError } from './errors.js';
import type { OperationDefinition, OperationRegistry, ResultOptions } from './operations.js';
import { createOperation, operationResult } from './operations.js';
import { validateTransactionSql } from './transaction-sql.js';
import type { Transaction } from './types.js';

/** Inline and registered SQL share validation, execution and result handling. */
export function createClient<O extends OperationRegistry>(
  operations: ReadonlyMap<string, OperationDefinition>,
  query: QueryExecutor,
): Transaction<O> {
  async function execute(name: string, operation: OperationDefinition, input: readonly unknown[]) {
    if (!Array.isArray(input)) {
      throw new TenonError('SQL input must be an explicit array.');
    }
    validateTransactionSql(operation.sql, name);
    return operationResult(name, operation, await query(operation.sql, input));
  }

  // Runtime dispatch cannot retain each registry member's phantom input/output
  // types. This is the single boundary between checked definitions and execution.
  return {
    async sql(sql: string, input: readonly unknown[], options?: ResultOptions) {
      return execute('Inline SQL', createOperation(sql, options), input);
    },
    async run(name: string, input: readonly unknown[]) {
      const operation = operations.get(name);
      if (!operation) {
        throw new TenonError(`Unknown operation: ${name}`);
      }
      return execute(name, operation, input);
    },
  } as Transaction<O>;
}
