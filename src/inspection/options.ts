import { plainObject } from '../validation.js';
import type { DescribeOptions } from './types.js';

/** Validate and capture caller-owned settings before opening a connection. */
export function inspectionOptions(
  options: Pick<DescribeOptions, 'connection' | 'session' | 'timeouts'>,
) {
  if (typeof options.connection !== 'string' || !options.connection.trim()) {
    throw new Error('Describe requires an explicit nonempty connection string.');
  }
  plainObject(options.session ?? {}, 'Inspection session');
  const session = { ...options.session };
  for (const [key, value] of Object.entries(session)) {
    if (!['role', 'searchPath', 'timeZone'].includes(key)) {
      throw new Error(`Unknown inspection session option: ${key}`);
    }
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      throw new Error(`Inspection session ${key} requires a nonempty string without NUL.`);
    }
  }
  plainObject(options.timeouts ?? {}, 'Inspection timeouts');
  const timeouts = { ...options.timeouts };
  const defaults = { connectMs: 3000, statementMs: 5000, lockMs: 1000 };
  for (const [key, value] of Object.entries(timeouts)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown inspection timeout: ${key}`);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647) {
      throw new Error(`Inspection timeout ${key} must be a positive integer in milliseconds.`);
    }
  }
  const limits = { ...defaults, ...timeouts };

  // URL startup options must not disable the inspection's server-side bounds.
  let url: URL;
  try {
    url = new URL(options.connection);
  } catch {
    throw new Error('Describe requires a PostgreSQL connection URI.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('Describe requires a PostgreSQL connection URI.');
  }
  for (const [name, value] of [
    ['statement_timeout', limits.statementMs],
    ['lock_timeout', limits.lockMs],
  ] as const) {
    url.searchParams.set(name, String(value));
  }
  if (!url.searchParams.has('application_name')) {
    url.searchParams.set('application_name', 'tenon-describe');
  }
  return { url, limits, session };
}
