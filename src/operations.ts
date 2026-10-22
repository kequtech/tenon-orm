import type { QueryResult, QueryResultRow } from 'pg';
import type { AffectedRowsConstraint } from './affected-rows.js';
import { validateAffectedRows } from './affected-rows.js';
import { TenonError } from './errors.js';
import type { SqlQuery, UnknownRow } from './query.js';
import { plainObject } from './validation.js';

export type OperationReturnMode = 'native' | 'many' | 'oneOrNone' | 'one';
export interface OperationOptions {
  readonly returns?: OperationReturnMode;
  readonly affectedRows?: AffectedRowsConstraint;
  /** Optional diagnostic label. No SQL or input values are sent to observers. */
  readonly label?: string;
}
export type OperationResult<
  Row extends QueryResultRow,
  Mode extends OperationReturnMode,
> = Mode extends 'native'
  ? QueryResult<Row>
  : Mode extends 'many'
    ? Row[]
    : Mode extends 'oneOrNone'
      ? Row | undefined
      : Row;

export interface OperationDefinition<
  Input extends readonly unknown[] = readonly unknown[],
  Row extends QueryResultRow = UnknownRow,
  Mode extends OperationReturnMode = OperationReturnMode,
> {
  readonly build: (...input: Input) => SqlQuery<Row>;
  readonly options: Readonly<OperationOptions & { returns: Mode }>;
}
const definitions = new WeakSet<object>();

/** Input types come from the factory parameters; the query carries its row type. */
export function defineOperation<Input extends readonly unknown[], Row extends QueryResultRow>(
  build: (...input: Input) => SqlQuery<Row>,
  options?: OperationOptions & { readonly returns?: 'native' },
): OperationDefinition<Input, Row, 'native'>;
export function defineOperation<
  Input extends readonly unknown[],
  Row extends QueryResultRow,
  Mode extends OperationReturnMode,
>(
  build: (...input: Input) => SqlQuery<Row>,
  options: OperationOptions & { readonly returns: Mode },
): OperationDefinition<Input, Row, Mode>;
export function defineOperation<Input extends readonly unknown[], Row extends QueryResultRow>(
  build: (...input: Input) => SqlQuery<Row>,
  options: OperationOptions | undefined,
): OperationDefinition<Input, Row>;
export function defineOperation<Input extends readonly unknown[], Row extends QueryResultRow>(
  build: (...input: Input) => SqlQuery<Row>,
  options?: OperationOptions,
): OperationDefinition<Input, Row> {
  if (typeof build !== 'function')
    throw new TenonError('defineOperation requires a query factory.');
  const config = validateOptions(options);
  const result = Object.freeze({ build, options: config });
  definitions.add(result);
  return result;
}

export function assertOperation(value: unknown): void {
  if (!value || typeof value !== 'object' || !definitions.has(value)) {
    throw new TenonError('run() requires an operation created with defineOperation().');
  }
}

export function validateOptions(
  options?: OperationOptions,
): Readonly<OperationOptions & { returns: OperationReturnMode }> {
  const config = options === undefined ? {} : plainObject(options, 'Operation options');
  for (const key of Object.keys(config)) {
    if (!['returns', 'affectedRows', 'label'].includes(key))
      throw new TenonError(`Unknown operation option: ${key}`);
  }
  const returns = config.returns ?? 'native';
  if (
    config.returns === null ||
    !['native', 'many', 'oneOrNone', 'one'].includes(returns as string)
  ) {
    throw new TenonError('Operation returns must be native, many, oneOrNone, or one.');
  }
  const affectedRows = validateAffectedRows(config.affectedRows);
  const label = config.label;
  if (label !== undefined && (typeof label !== 'string' || !label.trim())) {
    throw new TenonError('Operation label must be a nonempty string.');
  }
  return Object.freeze({
    returns: returns as OperationReturnMode,
    ...(affectedRows && { affectedRows }),
    ...(typeof label === 'string' && { label }),
  });
}

export function operationResult(
  options: OperationOptions,
  result: QueryResult<UnknownRow>,
): object | undefined {
  if (options.returns === 'native') return result;
  if (options.returns === 'many') return result.rows;
  const expected = options.returns === 'oneOrNone' ? 'at most one row' : 'exactly one row';
  if (result.rows.length > 1 || (options.returns === 'one' && result.rows.length === 0)) {
    throw new TenonError(
      `${options.label ?? 'Query'} expected ${expected}, but returned ${result.rows.length} rows.`,
    );
  }
  return result.rows[0];
}
