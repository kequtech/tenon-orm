import type { QueryResult } from 'pg';
import { AffectedRowsError, TenonError } from './errors.js';
import { plainObject } from './validation.js';

/** PostgreSQL's final command count, independent of RETURNING. */
export type AffectedRowsConstraint =
  | { readonly max: number; readonly exact?: never }
  | { readonly exact: number; readonly max?: never };

export function validateAffectedRows(value: unknown): AffectedRowsConstraint | undefined {
  if (value === undefined) return undefined;
  const config = plainObject(value, 'affectedRows');
  const keys = Object.keys(config);
  const key = keys[0];
  if (keys.length !== 1 || (key !== 'max' && key !== 'exact')) {
    throw new TenonError('affectedRows must specify exactly one of max or exact.');
  }
  const count = config[key];
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new TenonError('affectedRows must be a nonnegative safe integer.');
  }
  return Object.freeze(key === 'max' ? { max: count } : { exact: count });
}

export function checkAffectedRows(
  constraint: AffectedRowsConstraint,
  result: QueryResult<Record<string, unknown>>,
): void {
  if (
    !['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(result.command) ||
    result.rowCount === null ||
    !Number.isSafeInteger(result.rowCount) ||
    result.rowCount < 0
  ) {
    throw new AffectedRowsError(constraint, result.rowCount, result.command, false);
  }
  const expected = constraint.exact ?? constraint.max;
  const matches =
    constraint.exact === undefined ? result.rowCount <= expected : result.rowCount === expected;
  if (!matches) {
    throw new AffectedRowsError(constraint, result.rowCount, result.command, true);
  }
}
