import type postgres from 'postgres';

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
  statement: postgres.Statement;
  types: readonly CatalogType[];
  sources: readonly ColumnSource[];
}

/** Describe the statement and read its type and source-column catalog records. */
export async function readStatementMetadata(
  client: postgres.Sql,
  text: string,
): Promise<StatementMetadata> {
  const statement = await client.unsafe(text, [], { prepare: true }).describe();
  const oids = [...new Set([...statement.types, ...statement.columns.map((c) => c.type)])];
  const types = await client<CatalogType[]>`
    WITH RECURSIVE wanted(oid) AS (
      SELECT unnest(string_to_array(${oids.join(',')}, ',')::oid[])
      UNION
      SELECT t.typbasetype FROM pg_catalog.pg_type t JOIN wanted w ON w.oid = t.oid
        WHERE t.typbasetype <> 0
    )
    SELECT t.oid, n.nspname AS schema, t.typname AS name,
      t.typtype AS kind, t.typbasetype AS base,
      (SELECT to_json(array_agg(e.enumlabel::text ORDER BY e.enumsortorder))
        FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid) AS choices
    FROM wanted w JOIN pg_catalog.pg_type t ON t.oid = w.oid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  `;
  const tables = [...new Set(statement.columns.map((c) => c.table).filter(Boolean))];
  const sources = await client<ColumnSource[]>`
    SELECT c.oid, a.attnum AS number, n.nspname AS schema,
      c.relname AS table, a.attname AS column, a.attnotnull AS "notNull"
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = ANY(string_to_array(${tables.join(',')}, ',')::oid[])
      AND a.attnum > 0 AND NOT a.attisdropped
  `;
  return { statement, types, sources };
}
