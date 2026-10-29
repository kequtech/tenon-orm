import type { CatalogClient } from './catalog.js';

import { quote } from '../sql.js';

interface NamedDefinition {
  name: string;
  definition: string;
}
interface IndexDefinition {
  definition: string;
  prefix: string;
  qualification: string;
  valid: boolean;
  ready: boolean;
}

/** Include only domains reached through selected columns, base domains or arrays. */
export async function domainSummaries(
  client: CatalogClient,
  typeOids: readonly string[],
): Promise<string[]> {
  const domains = await client.query<{
    oid: string;
    name: string;
    base: string;
    nullable: boolean;
    expression: string | null;
    collation: string | null;
  }>(
    `
    WITH RECURSIVE referenced(oid) AS (
      SELECT pg_catalog.unnest(pg_catalog.string_to_array($1, ',')::pg_catalog.oid[])
      UNION
      SELECT child.oid FROM referenced r JOIN pg_catalog.pg_type t ON t.oid = r.oid
        CROSS JOIN LATERAL (VALUES (t.typbasetype), (t.typelem)) child(oid)
      WHERE child.oid <> 0
    )
    SELECT t.oid::text AS oid, pg_catalog.format_type(t.oid, NULL) AS name,
      pg_catalog.format_type(t.typbasetype, t.typtypmod) AS base,
      NOT t.typnotnull AS nullable, pg_catalog.pg_get_expr(t.typdefaultbin, 0, false) AS expression,
      CASE WHEN t.typcollation <> base.typcollation THEN t.typcollation::pg_catalog.regcollation::text END AS collation
    FROM referenced r JOIN pg_catalog.pg_type t ON t.oid = r.oid
      JOIN pg_catalog.pg_type base ON base.oid = t.typbasetype
    WHERE t.typtype = 'd'
    ORDER BY pg_catalog.format_type(t.oid, NULL) COLLATE "C"`,
    [typeOids.join(',')],
  );
  const summaries: string[] = [];
  for (const domain of domains.rows) {
    const constraints = await client.query<NamedDefinition>(
      `
      SELECT conname AS name, pg_catalog.pg_get_constraintdef(oid, false) AS definition
      FROM pg_catalog.pg_constraint WHERE contypid = $1::oid
      ORDER BY conname COLLATE "C"`,
      [domain.oid],
    );
    summaries.push(
      [
        `DOMAIN ${domain.name} AS ${domain.base}` +
          (domain.collation === null ? '' : ` COLLATE ${domain.collation}`) +
          (domain.expression === null ? '' : ` DEFAULT ${domain.expression}`) +
          (domain.nullable ? '' : ' NOT NULL'),
        ...constraints.rows.map(
          (constraint) => `  CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`,
        ),
      ].join('\n'),
    );
  }
  return summaries;
}

/** Called inside generation's read-only snapshot, with a fixed local search_path. */
export async function tableSummary(
  client: CatalogClient,
  oid: string,
  name: string,
): Promise<string> {
  const columns = await client.query<NamedDefinition>(
    `
    SELECT a.attname AS name,
      pg_catalog.format_type(a.atttypid, a.atttypmod)
      || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
      || CASE
        WHEN a.attidentity <> '' THEN
          ' GENERATED ' || CASE a.attidentity WHEN 'a' THEN 'ALWAYS' ELSE 'BY DEFAULT' END
          || ' AS IDENTITY' || pg_catalog.format(
            ' (START WITH %s INCREMENT BY %s MINVALUE %s MAXVALUE %s CACHE %s %s)',
            s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache,
            CASE WHEN s.seqcycle THEN 'CYCLE' ELSE 'NO CYCLE' END)
        WHEN a.attgenerated <> '' THEN
          ' GENERATED ALWAYS AS (' || pg_catalog.pg_get_expr(d.adbin, d.adrelid, false)
          || ')' || CASE a.attgenerated WHEN 's' THEN ' STORED' WHEN 'v' THEN ' VIRTUAL' ELSE '' END
        WHEN d.oid IS NOT NULL THEN ' DEFAULT ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid, false)
        ELSE ''
      END AS definition
    FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_catalog.pg_depend dep ON a.attidentity <> ''
        AND dep.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND dep.refobjid = a.attrelid AND dep.refobjsubid = a.attnum
        AND dep.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND dep.deptype = 'i'
      LEFT JOIN pg_catalog.pg_sequence s ON s.seqrelid = dep.objid
    WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`,
    [oid],
  );
  // Column definitions already describe NOT NULL; PostgreSQL 18 also stores it
  // as a table constraint, which would duplicate every required column here.
  const constraints = await client.query<NamedDefinition>(
    `
    SELECT conname AS name, pg_catalog.pg_get_constraintdef(oid, false) AS definition
    FROM pg_catalog.pg_constraint
    WHERE conrelid = $1::oid AND conparentid = 0 AND contype IN ('p', 'u', 'f', 'c', 'x')
    ORDER BY conname COLLATE "C"`,
    [oid],
  );
  const indexes = await client.query<IndexDefinition>(
    `
    SELECT pg_catalog.pg_get_indexdef(i.indexrelid, 0, false) AS definition,
      pg_catalog.format('CREATE %sINDEX %I ON %s',
        CASE WHEN i.indisunique THEN 'UNIQUE ' ELSE '' END, ic.relname,
        CASE WHEN t.relkind = 'p' THEN 'ONLY ' ELSE '' END) AS prefix,
      pg_catalog.quote_ident(n.nspname) || '.' AS qualification,
      i.indisvalid AS valid, i.indisready AS ready
    FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE i.indrelid = $1::oid
    ORDER BY ic.relname COLLATE "C"`,
    [oid],
  );
  const lines = [
    `TABLE ${quote(name)}`,
    ...columns.rows.map((column) => `  ${quote(column.name)} ${column.definition}`),
    ...constraints.rows.map(
      (constraint) => `  CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`,
    ),
    ...indexes.rows.map((index) => {
      // pg_get_indexdef always qualifies its target table. Remove only that
      // known prefix, never matching/replacing namespace text inside SQL literals.
      const qualifiedPrefix = index.prefix + index.qualification;
      if (!index.definition.startsWith(qualifiedPrefix)) {
        throw new Error(`Unexpected PostgreSQL index definition for ${quote(name)}.`);
      }
      const definition = index.prefix + index.definition.slice(qualifiedPrefix.length);
      return `  ${definition}${index.valid ? '' : ' [INVALID]'}${index.ready ? '' : ' [NOT READY]'}`;
    }),
  ];
  return lines.join('\n');
}

export function schemaSummary(summaries: readonly string[]): string {
  const text = [
    'Schema summary — same database checkpoint as the row types below.',
    'Unqualified application names use the selected namespace; pg_catalog is also in the search path.',
    'Descriptive catalog output, not a migration script. Includes constraint-backed indexes.',
    ...summaries.map((summary) => `\n${summary}`),
  ].join('\n');
  // Identifiers and SQL literals can contain any JavaScript line terminator.
  // Prefix every physical line so catalog text always remains a comment.
  return (
    text
      .split(/\r\n|[\n\r\u2028\u2029]/u)
      .map((line) => `//${line ? ` ${line}` : ''}`)
      .join('\n') + '\n\n'
  );
}
