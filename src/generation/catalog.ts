import { builtin, param, type InputValue, type QueryResult, type Row } from '@kequtech/pgclear';

export interface CatalogClient {
  query<T extends object = Row>(
    text: string,
    values?: readonly InputValue[],
  ): Promise<QueryResult<T>>;
}

export interface ColumnRow {
  name: string;
  oid: string;
  typeKind: string;
  declaredOid: string;
  nullable: boolean;
  writeNullable: boolean;
  hasDefault: boolean;
  writable: boolean;
  choices: string[] | null;
}
export interface TableRow {
  oid: string;
  name: string;
  columns: ColumnRow[];
}

export async function readTables(
  client: CatalogClient,
  namespace: string,
  exclude: readonly string[],
): Promise<TableRow[]> {
  const tables = await client.query<{ oid: string; name: string }>(
    `
      SELECT c.oid::text AS oid, c.relname AS name
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT (c.relname = ANY($2::text[])) AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
      ORDER BY c.relname COLLATE "C"`,
    [namespace, param(exclude, builtin.textArray)],
  );
  const definitions: TableRow[] = [];
  for (const table of tables.rows) {
    // Attached descendants are storage details, not separate generated models.
    const columns = await client.query<ColumnRow>(
      `
        WITH RECURSIVE resolved AS (
          SELECT a.attnum, t.oid, t.typbasetype, t.typnotnull AS domain_not_null
          FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
          WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
          UNION ALL
          SELECT r.attnum, t.oid, t.typbasetype, r.domain_not_null OR t.typnotnull
          FROM resolved r JOIN pg_catalog.pg_type t ON t.oid = r.typbasetype
        )
        SELECT a.attname AS name, t.oid::text AS oid, t.typtype AS "typeKind",
          declared.oid::text AS "declaredOid",
          NOT a.attnotnull AS nullable,
          NOT (a.attnotnull OR r.domain_not_null) AS "writeNullable",
          (a.atthasdef OR declared.typdefaultbin IS NOT NULL OR a.attidentity <> '') AS "hasDefault",
          (a.attgenerated = '' AND a.attidentity <> 'a') AS writable,
          (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid) AS choices
        FROM pg_catalog.pg_attribute a
          JOIN resolved r ON r.attnum = a.attnum AND r.typbasetype = 0
          JOIN pg_catalog.pg_type t ON t.oid = r.oid
          JOIN pg_catalog.pg_type declared ON declared.oid = a.atttypid
        WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [table.oid],
    );
    definitions.push({ ...table, columns: [...columns.rows] });
  }
  return definitions;
}
