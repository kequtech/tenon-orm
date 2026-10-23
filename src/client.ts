import { checkAffectedRows } from './affected-rows.js';
import type { QueryExecutor } from './connection.js';
import type { OperationDefinition, OperationOptions } from './operations.js';
import { assertOperation, operationResult, validateOptions } from './operations.js';
import type { SqlQuery } from './query.js';
import { assertQuery } from './query.js';
import { validateTransactionSql } from './transaction-sql.js';
import type { QueryEvent, Transaction } from './types.js';

/** All public execution shares validation, atomic checks, and result handling. */
export function createClient(
  query: QueryExecutor,
  onQuery?: (event: QueryEvent) => void | Promise<void>,
): Transaction {
  async function execute(statement: SqlQuery, options: OperationOptions) {
    assertQuery(statement);
    validateTransactionSql(statement.text, options.label ?? 'Query');
    const started = performance.now();
    let command: string | undefined;
    let rowCount: number | null | undefined;
    let failure: unknown;
    let succeeded = false;
    try {
      const value = await query(
        statement.text,
        statement.values,
        (result) => {
          command = result.command;
          rowCount = result.rowCount;
          if (options.affectedRows) checkAffectedRows(options.affectedRows, result);
          return operationResult(options, result);
        },
        options.affectedRows !== undefined,
      );
      succeeded = true;
      return value;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (onQuery) {
        const code =
          failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined;
        const event: QueryEvent = Object.freeze({
          ...(options.label && { label: options.label }),
          durationMs: performance.now() - started,
          outcome: succeeded ? 'success' : 'error',
          ...(command !== undefined && { command }),
          ...(rowCount !== undefined && { rowCount }),
          ...(typeof code === 'string' && { errorCode: code }),
        });
        // Diagnostics must not turn a committed write into an apparent failure.
        const report = () =>
          process.emitWarning('Tenon onQuery callback failed; query outcome was preserved.');
        try {
          void Promise.resolve(onQuery(event)).catch(report);
        } catch {
          report();
        }
      }
    }
  }
  return {
    async query(statement: SqlQuery, options?: OperationOptions) {
      return execute(statement, validateOptions(options));
    },
    async run(operation: OperationDefinition, input: readonly unknown[]) {
      assertOperation(operation);
      if (!Array.isArray(input)) throw new Error('Operation input must be an explicit array.');
      const options = validateOptions(operation.options);
      return execute(operation.build(...input), options);
    },
  } as Transaction;
}
