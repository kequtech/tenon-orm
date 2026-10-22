import type { PoolClient } from 'pg';
import { migrationTable } from '../migrations/history.js';

export interface ColumnRow {
  name: string;
  oid: string;
  type: string;
  typeSchema: string;
  typeKind: string;
  declaredOid: string;
  declaredType: string;
  declaredSchema: string;
  nullable: boolean;
  choices: string[] | null;
}
export interface TableRow {
  oid: string;
  name: string;
  columns: ColumnRow[];
}

export async function readTables(client: PoolClient, namespace: string): Promise<TableRow[]> {
  const tables = await client.query<{ oid: string; name: string }>(
    `
      SELECT c.oid::text AS oid, c.relname AS name
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname <> $2 AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
      ORDER BY c.relname COLLATE "C"`,
    [namespace, migrationTable],
  );
  const definitions: TableRow[] = [];
  for (const table of tables.rows) {
    // Attached descendants are storage details, not separate generated models.
    const columns = await client.query<ColumnRow>(
      `
        WITH RECURSIVE resolved AS (
          SELECT a.attnum, t.oid, t.typbasetype
          FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
          WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
          UNION ALL
          SELECT r.attnum, t.oid, t.typbasetype
          FROM resolved r JOIN pg_catalog.pg_type t ON t.oid = r.typbasetype
        )
        SELECT a.attname AS name, t.oid::text AS oid, t.typname AS type, tn.nspname AS "typeSchema", t.typtype AS "typeKind",
          declared.oid::text AS "declaredOid", declared.typname AS "declaredType", dn.nspname AS "declaredSchema",
          NOT a.attnotnull AS nullable,
          (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid) AS choices
        FROM pg_catalog.pg_attribute a
          JOIN resolved r ON r.attnum = a.attnum AND r.typbasetype = 0
          JOIN pg_catalog.pg_type t ON t.oid = r.oid
          JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
          JOIN pg_catalog.pg_type declared ON declared.oid = a.atttypid
          JOIN pg_catalog.pg_namespace dn ON dn.oid = declared.typnamespace
        WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [table.oid],
    );
    definitions.push({ ...table, columns: columns.rows });
  }
  return definitions;
}
