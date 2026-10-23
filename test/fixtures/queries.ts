import type { QueryClient } from '../../src/index.js';
import { sql } from '../../src/index.js';

// A normal application function works with either a database or a transaction.
export const echoValues = (
  client: QueryClient,
  { label, enabled }: { label: string; enabled: boolean },
) =>
  client.query(
    sql<{
      label: string;
      enabled: boolean;
    }>`SELECT ${label}::text AS label, ${enabled}::boolean AS enabled`,
    { returns: 'many' },
  );
