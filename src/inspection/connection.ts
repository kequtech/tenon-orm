import { Client } from 'pg';
import { inspectionOptions } from './options.js';
import type { DescribeOptions, InspectionContext } from './types.js';

/** Bound every database statement, including bootstrap and metadata queries. */
export async function withInspectionConnection<T>(
  options: Pick<DescribeOptions, 'connection' | 'session' | 'timeouts'>,
  work: (client: Client, context: InspectionContext) => Promise<T>,
): Promise<T> {
  const { url, limits, session } = inspectionOptions(options);
  const client = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: limits.connectMs,
    statement_timeout: limits.statementMs,
    lock_timeout: limits.lockMs,
    pipeline: false,
  });
  // Disconnection errors outside an active query must still have a listener.
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query(
      `SELECT
      pg_catalog.set_config('statement_timeout', $1, false),
      pg_catalog.set_config('lock_timeout', $2, false)`,
      [String(limits.statementMs), String(limits.lockMs)],
    );
    for (const [key, name] of [
      ['role', 'role'],
      ['searchPath', 'search_path'],
      ['timeZone', 'TimeZone'],
    ] as const) {
      const value = session[key];
      if (value !== undefined)
        await client.query('SELECT pg_catalog.set_config($1, $2, false)', [name, value]);
    }
    const {
      rows: [context],
    } = await client.query<Omit<InspectionContext, 'mode' | 'readMappings'>>(`
      SELECT pg_catalog.current_database() AS database, session_user AS "sessionUser",
        current_user AS "currentUser", pg_catalog.current_setting('search_path') AS "searchPath",
        pg_catalog.to_json(pg_catalog.current_schemas(true)) AS "resolvedSearchPath",
        pg_catalog.current_setting('TimeZone') AS "timeZone",
        (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS "statementTimeoutMs",
        (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS "lockTimeoutMs"
    `);
    if (!context) throw new Error('Inspection context was not returned.');
    return await work(client, { mode: 'separate-session', readMappings: 'pg', ...context });
  } finally {
    await client.end();
  }
}
