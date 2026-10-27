import postgres from 'postgres';
import { prepareArrays } from '../driver/array.js';
import { inspectionOptions } from './options.js';
import type { DescribeOptions, InspectionContext } from './types.js';

/** Bound every database statement, including bootstrap and metadata queries. */
export async function withInspectionConnection<T>(
  options: Pick<DescribeOptions, 'connection' | 'session' | 'timeouts'>,
  work: (client: postgres.Sql, context: InspectionContext) => Promise<T>,
): Promise<T> {
  const { url, limits, session } = inspectionOptions(options);
  const client = postgres(url.toString(), {
    max: 1,
    connect_timeout: limits.connectMs / 1000,
    // The inspector reads its own metadata; avoid an implicit array-catalog fetch.
    fetch_types: false,
    onnotice() {},
  });
  try {
    await client`SELECT
      set_config('statement_timeout', ${String(limits.statementMs)}, false),
      set_config('lock_timeout', ${String(limits.lockMs)}, false)`;
    await prepareArrays(client);
    for (const [key, name] of [
      ['role', 'role'],
      ['searchPath', 'search_path'],
      ['timeZone', 'TimeZone'],
    ] as const) {
      const value = session[key];
      if (value !== undefined) await client`SELECT set_config(${name}, ${value}, false)`;
    }
    const [context] = await client<Omit<InspectionContext, 'mode' | 'readMappings'>[]>`
      SELECT current_database() AS database, session_user AS "sessionUser",
        current_user AS "currentUser", current_setting('search_path') AS "searchPath",
        to_json(current_schemas(true)) AS "resolvedSearchPath",
        current_setting('TimeZone') AS "timeZone",
        (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS "statementTimeoutMs",
        (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS "lockTimeoutMs"
    `;
    if (!context) throw new Error('Inspection context was not returned.');
    return await work(client, { mode: 'separate-session', readMappings: 'postgres', ...context });
  } finally {
    // Bound cleanup as well; never leave an unbounded end() after a server/network failure.
    await client.end({ timeout: 1 });
  }
}
