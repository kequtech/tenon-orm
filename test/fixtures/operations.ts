import { defineOperation, sql } from '../../src/index.js';

// Import this definition directly; its parameter and result types travel with it.
export const echo_values = defineOperation(
  (label: string, enabled: boolean) =>
    sql<{
      label: string;
      enabled: boolean;
    }>`SELECT ${label}::text AS label, ${enabled}::boolean AS enabled`,
  { returns: 'many' },
);
