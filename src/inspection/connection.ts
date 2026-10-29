import { connect, type Session } from '@kequtech/pgclear';

import { inspectionOptions } from './options.js';
import type { DescribeOptions, InspectionContext } from './types.js';

export async function withInspectionConnection<T>(
  options: Pick<DescribeOptions, 'connection' | 'session' | 'timeouts'>,
  work: (client: Session, context: InspectionContext) => Promise<T>,
): Promise<T> {
  const { url, limits, session } = inspectionOptions(options);
  const connection = await connect({
    connectionString: url.toString(),
    connectTimeoutMs: limits.connectMs,
    startupParameters: {
      statement_timeout: String(limits.statementMs),
      lock_timeout: String(limits.lockMs),
    },
  });
  const client = connection;
  try {
    for (const [key, name] of [
      ['role', 'role'],
      ['searchPath', 'search_path'],
      ['timeZone', 'TimeZone'],
    ] as const) {
      const value = session[key];
      if (value !== undefined)
        await client.queryClassic('SELECT pg_catalog.set_config($1, $2, false)', [name, value]);
    }
    const {
      rows: [context],
    } = await client.queryClassic<Omit<InspectionContext, 'mode' | 'readMappings'>>(
      `
      SELECT pg_catalog.current_database() AS database,
        session_user AS "sessionUser", current_user AS "currentUser",
        pg_catalog.current_setting('search_path') AS "searchPath",
        pg_catalog.to_json(pg_catalog.current_schemas(true)) AS "resolvedSearchPath",
        pg_catalog.current_setting('TimeZone') AS "timeZone",
        (SELECT setting::integer FROM pg_catalog.pg_settings
          WHERE name = 'statement_timeout') AS "statementTimeoutMs",
        (SELECT setting::integer FROM pg_catalog.pg_settings
          WHERE name = 'lock_timeout') AS "lockTimeoutMs"
    `,
      [],
    );
    if (!context) throw new Error('Inspection context was not returned.');
    return await work(client, { mode: 'separate-session', readMappings: 'pgclear', ...context });
  } finally {
    await connection.close();
  }
}
