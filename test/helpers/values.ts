import assert from 'node:assert/strict';

export function assertInfinity(value: unknown) {
  assert.equal(typeof value, 'number');
  assert.ok(value === Infinity || value === -Infinity);
}
