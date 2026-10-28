import type { AffectedRowsConstraint } from './affected-rows.js';

export class CardinalityError extends Error {
  override name = 'CardinalityError';
  readonly code = 'TENON_CARDINALITY_MISMATCH';
  readonly expected: 'one' | 'oneOrNone';
  readonly actual: number;
  readonly label?: string;

  constructor(expected: 'one' | 'oneOrNone', actual: number, label?: string) {
    const count = expected === 'one' ? 'exactly one row' : 'at most one row';
    super(`${label ?? 'Query'} expected ${count}, but returned ${actual} rows.`);
    this.expected = expected;
    this.actual = actual;
    if (label !== undefined) this.label = label;
  }
}

export class AffectedRowsError extends Error {
  override name = 'AffectedRowsError';
  readonly code: 'TENON_AFFECTED_ROWS_MISMATCH' | 'TENON_AFFECTED_ROWS_UNSUPPORTED';
  readonly expected: AffectedRowsConstraint;
  readonly actual: number | null;
  readonly command: string;

  constructor(
    expected: AffectedRowsConstraint,
    actual: number | null,
    command: string,
    supported: boolean,
  ) {
    const limit = expected.exact ?? expected.max;
    const comparison = expected.exact === undefined ? 'at most' : 'exactly';
    super(
      supported
        ? `Expected ${comparison} ${limit} affected rows, but PostgreSQL reported ${actual}.`
        : 'affectedRows requires an INSERT, UPDATE, DELETE, or MERGE command count.',
    );
    this.code = supported ? 'TENON_AFFECTED_ROWS_MISMATCH' : 'TENON_AFFECTED_ROWS_UNSUPPORTED';
    this.expected = Object.freeze({ ...expected });
    this.actual = actual;
    this.command = command;
  }
}
