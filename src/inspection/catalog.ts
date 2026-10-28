import type { Client } from 'pg';
import { describe, type Description } from './protocol.js';

interface CatalogType {
  oid: number;
  schema: string;
  name: string;
  kind: string;
  base: number;
  choices: string[] | null;
}

interface ColumnSource {
  oid: number;
  number: number;
  schema: string;
  table: string;
  column: string;
  notNull: boolean;
}

export interface StatementMetadata {
  statement: Description;
  types: readonly CatalogType[];
  sources: readonly ColumnSource[];
}

/** Describe the statement and read its type and source-column catalog records. */
export async function readStatementMetadata(
  client: Client,
  text: string,
): Promise<StatementMetadata> {
  const statement = await describe(client, text);
  const oids = [
    ...new Set([...statement.parameters, ...statement.fields.map((c) => c.dataTypeID)]),
  ];
  const types = (
    await client.query<CatalogType>(
      `
    WITH RECURSIVE wanted(oid) AS (
      SELECT pg_catalog.unnest(pg_catalog.string_to_array($1, ',')::pg_catalog.oid[])
      UNION
      SELECT t.typbasetype FROM pg_catalog.pg_type t JOIN wanted w ON w.oid = t.oid
        WHERE t.typbasetype <> 0
    )
    SELECT t.oid, n.nspname AS schema, t.typname AS name,
      t.typtype AS kind, t.typbasetype AS base,
      (SELECT pg_catalog.to_json(pg_catalog.array_agg(e.enumlabel::text ORDER BY e.enumsortorder))
        FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid) AS choices
    FROM wanted w JOIN pg_catalog.pg_type t ON t.oid = w.oid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  `,
      [oids.join(',')],
    )
  ).rows;
  const tables = [...new Set(statement.fields.map((c) => c.tableID).filter(Boolean))];
  const sources = (
    await client.query<ColumnSource>(
      `
    SELECT c.oid, a.attnum AS number, n.nspname AS schema,
      c.relname AS table, a.attname AS column, a.attnotnull AS "notNull"
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = ANY(pg_catalog.string_to_array($1, ',')::pg_catalog.oid[])
      AND a.attnum > 0 AND NOT a.attisdropped
  `,
      [tables.join(',')],
    )
  ).rows;
  return { statement, types, sources };
}
