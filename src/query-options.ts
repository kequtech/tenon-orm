import type { QueryResult } from './connection.js';
import type { AffectedRowsConstraint } from './affected-rows.js';
import { validateAffectedRows } from './affected-rows.js';
import type { UnknownRow } from './query.js';
import { plainObject } from './validation.js';
import { CardinalityError } from './errors.js';

export type QueryReturnMode = 'native' | 'many' | 'oneOrNone' | 'one';
export interface QueryOptions {
  readonly returns?: QueryReturnMode;
  readonly affectedRows?: AffectedRowsConstraint;
  /** Optional diagnostic label. No SQL or input values are sent to observers. */
  readonly label?: string;
}
export type QueryOutput<Row extends object, Mode extends QueryReturnMode> = Mode extends 'native'
  ? QueryResult<Row>
  : Mode extends 'many'
    ? Row[]
    : Mode extends 'oneOrNone'
      ? Row | undefined
      : Row;

export function validateOptions(
  options?: QueryOptions,
): Readonly<QueryOptions & { returns: QueryReturnMode }> {
  const config = options === undefined ? {} : plainObject(options, 'Query options');
  for (const key of Object.keys(config)) {
    if (!['returns', 'affectedRows', 'label'].includes(key))
      throw new Error(`Unknown query option: ${key}`);
  }
  const returns = config.returns ?? 'native';
  if (
    config.returns === null ||
    !['native', 'many', 'oneOrNone', 'one'].includes(returns as string)
  ) {
    throw new Error('Query returns must be native, many, oneOrNone, or one.');
  }
  const affectedRows = validateAffectedRows(config.affectedRows);
  const label = config.label;
  if (label !== undefined && (typeof label !== 'string' || !label.trim())) {
    throw new Error('Query label must be a nonempty string.');
  }
  return Object.freeze({
    returns: returns as QueryReturnMode,
    ...(affectedRows && { affectedRows }),
    ...(typeof label === 'string' && { label }),
  });
}

export function queryOutput(
  options: QueryOptions,
  result: QueryResult<UnknownRow>,
): object | undefined {
  if (options.returns === 'native') return result;
  if (options.returns === 'many') return [...result];
  if (result.length > 1 || (options.returns === 'one' && result.length === 0)) {
    throw new CardinalityError(
      options.returns === 'oneOrNone' ? 'oneOrNone' : 'one',
      result.length,
      options.label,
    );
  }
  return result[0];
}
