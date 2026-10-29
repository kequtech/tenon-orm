import type { Session } from '@kequtech/pgclear';
import type { Description, DescribeStatement } from '@kequtech/pgclear';

interface CatalogType {
  oid: number;
  schema: string;
  name: string;
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
  client: Session,
  query: DescribeStatement,
): Promise<StatementMetadata> {
  const statement = await client.describe(query);
  const oids = [
    ...new Set([...statement.parameterTypes, ...statement.fields.map((c) => c.dataTypeOid)]),
  ];
  const types = (
    await client.queryClassic<CatalogType>(
      `
    SELECT t.oid, n.nspname AS schema, t.typname AS name
    FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE t.oid = ANY(pg_catalog.string_to_array($1, ',')::pg_catalog.oid[])
  `,
      [oids.join(',')],
    )
  ).rows;
  const tables = [...new Set(statement.fields.map((c) => c.tableOid).filter(Boolean))];
  const sources = (
    await client.queryClassic<ColumnSource>(
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
