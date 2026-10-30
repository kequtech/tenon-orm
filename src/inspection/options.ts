import { plainObject } from '../validation.js';
import type { DescribeOptions, InspectionSession, InspectionTimeouts } from './types.js';
import type { ConnectionOptions } from '../connection.js';
import { configConnection } from '../config/connection.js';

const defaults = { connectMs: 3000, statementMs: 5000, lockMs: 1000 };

export function sessionOptions(value: unknown): InspectionSession {
  const input = plainObject(value, 'Inspection session');
  const session = { ...input };
  for (const [key, value] of Object.entries(session)) {
    if (!['role', 'searchPath', 'timeZone'].includes(key)) {
      throw new Error(`Unknown inspection session option: ${key}`);
    }
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      throw new Error(`Inspection session ${key} requires a nonempty string without NUL.`);
    }
  }
  return session as InspectionSession;
}

export function timeoutOptions(value: unknown): InspectionTimeouts {
  const input = plainObject(value, 'Inspection timeouts');
  const timeouts = { ...input };
  for (const [key, value] of Object.entries(timeouts)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown inspection timeout: ${key}`);
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647) {
      throw new Error(`Inspection timeout ${key} must be a positive integer in milliseconds.`);
    }
  }
  return timeouts as InspectionTimeouts;
}

/** Validate and capture caller-owned settings before opening a connection. */
export function inspectionOptions(
  options: Pick<DescribeOptions, 'connection' | 'session' | 'timeouts'>,
) {
  const selected = configConnection(options.connection);
  let connection: ConnectionOptions =
    typeof selected === 'string' ? { connectionString: selected } : { ...selected };
  if (connection.startupParameters !== undefined) {
    plainObject(connection.startupParameters, 'Startup parameters');
  }
  const session = sessionOptions(options.session ?? {});
  const timeouts = timeoutOptions(options.timeouts ?? {});
  const limits = {
    connectMs: timeouts.connectMs ?? defaults.connectMs,
    statementMs: timeouts.statementMs ?? defaults.statementMs,
    lockMs: timeouts.lockMs ?? defaults.lockMs,
  };

  // URL startup options must not disable the inspection's server-side bounds.
  if (connection.connectionString !== undefined) {
    let url: URL;
    try {
      url = new URL(connection.connectionString);
    } catch {
      throw new Error('Describe requires a PostgreSQL connection URI.');
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error('Describe requires a PostgreSQL connection URI.');
    }
    if (!url.searchParams.has('application_name') && connection.applicationName === undefined) {
      url.searchParams.set('application_name', 'tenon-describe');
    }
    connection = { ...connection, connectionString: url.toString() };
  } else if (connection.applicationName === undefined) {
    connection = { ...connection, applicationName: 'tenon-describe' };
  }
  return { connection, limits, session };
}
