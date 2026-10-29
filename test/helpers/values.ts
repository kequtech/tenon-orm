import assert from 'node:assert/strict';
export function assertInfinity(value: unknown) {
  assert.ok(value === 'infinity' || value === '-infinity');
}
