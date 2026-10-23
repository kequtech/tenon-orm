export function plainObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${name} must be a plain object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${name} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}
