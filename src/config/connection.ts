import type { ConnectionOptions } from '../connection.js';
import { plainObject } from '../validation.js';

/** Resolve only when a command or application actually needs its configured database. */
export function configConnection(value: unknown): string | ConnectionOptions {
  if (value === undefined) {
    throw new Error(
      'Tenon config connection is required. Check its database environment variables.',
    );
  }
  if (typeof value === 'string') {
    if (!value.trim()) throw new Error('Tenon config connection string must be nonempty.');
    return value;
  }
  if (value !== null && typeof value === 'object' && ('acquire' in value || 'close' in value)) {
    throw new Error('Tenon config requires connection options, not an open pool.');
  }
  const connection = plainObject(value, 'Tenon config connection');
  // An explicitly configured URI must never silently fall back to the driver's local defaults.
  if (
    'connectionString' in connection &&
    (typeof connection.connectionString !== 'string' || !connection.connectionString.trim())
  ) {
    throw new Error(
      'Tenon config connectionString must be nonempty. Check its database environment variables.',
    );
  }
  return connection as ConnectionOptions;
}
