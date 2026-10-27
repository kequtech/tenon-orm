import assert from 'node:assert/strict';

/** Invalid Date objects are not deep-equal on Node 24; verify their actual semantics. */
export function assertInvalidDate(value: unknown): asserts value is Date {
  assert.ok(value instanceof Date);
  assert.ok(Number.isNaN(value.getTime()));
}
