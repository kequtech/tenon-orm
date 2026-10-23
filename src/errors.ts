import type { AffectedRowsConstraint } from './affected-rows.js';

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
