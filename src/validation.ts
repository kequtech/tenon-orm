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

/** Validate before resolving paths so an empty override cannot become the working directory. */
export function validatePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} must be a nonempty path without NUL.`);
  }
}
