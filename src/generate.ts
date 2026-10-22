import { TenonError } from './errors.js';
import { migrationState, readMigrations } from './migrations.js';
import { migrationTable, withToolConnection } from './tooling.js';
import type { DatabaseToolOptions } from './tooling.js';
import { domainSummaries, schemaSummary, tableSummary } from './schema-summary.js';
import { quote } from './sql.js';

export interface GenerateOptions extends DatabaseToolOptions {
  /** Receives generation warnings; defaults to console.warn. */
  readonly onWarning?: (message: string) => void;
}
interface ColumnRow {
  name: string; oid: string; type: string; typeSchema: string; typeKind: string;
  declaredOid: string; declaredType: string; declaredSchema: string;
  nullable: boolean; choices: string[] | null;
}
interface TableRow { name: string; columns: ColumnRow[] }
const json = JSON.stringify;
// Every generated table remains accessible through Rows["exact SQL name"].
const reservedTypeNames = new Set((
  'await break case catch class const continue debugger default delete do else enum export extends false finally for function ' +
  'if implements import in instanceof interface let new null package private protected public return static super switch this ' +
  'throw true try typeof var void while with yield any bigint boolean intrinsic never number object string symbol undefined unknown ' +
  'Rows migrationHistory globalThis PgArray'
).split(' '));
function canExportRowName(name: string): boolean {
  return /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(name) && !reservedTypeNames.has(name);
}

// Exact built-in OIDs with verified default pg text parsers. Array parsers do
// not necessarily use their scalar type's representation (notably numeric[]).
const arrayTypes: Readonly<Record<string, string>> = {
  '1000': 'boolean', '1001': 'import("node:buffer").Buffer', '1007': 'number',
  '1016': 'string', '1231': 'number', '1009': 'string', '1015': 'string',
  '2951': 'string', '1185': 'globalThis.Date', '199': 'unknown', '3807': 'unknown',
};
function isSupportedArray(value: ColumnRow): boolean { return Object.hasOwn(arrayTypes, value.oid); }

function columnType(value: ColumnRow, column: string, onWarning: (message: string) => void): string {
  let scalar: string;
  if (isSupportedArray(value)) {
    scalar = `PgArray<${arrayTypes[value.oid]!}>`;
  } else if (value.typeKind === 'e') {
    if (!value.choices?.length) throw new TenonError(`Empty enum for ${value.name}`);
    scalar = value.choices.map(choice => json(choice)).join(' | ');
  } else {
    const supported: Readonly<Record<string, string>> = {
      int4: 'number', bool: 'boolean', text: 'string', varchar: 'string', uuid: 'string', timestamptz: 'globalThis.Date',
      int8: 'string', numeric: 'string', json: 'unknown', jsonb: 'unknown', bytea: 'import("node:buffer").Buffer',
    };
    const type = value.typeSchema === 'pg_catalog' && Object.hasOwn(supported, value.type) ? supported[value.type] : undefined;
    if (type) scalar = type;
    else {
      const underlying = value.declaredOid === value.oid ? ''
        : ` with underlying type ${json(value.typeSchema)}.${json(value.type)} (OID ${value.oid})`;
      onWarning(`Column ${column} uses PostgreSQL type ${json(value.declaredSchema)}.${json(value.declaredType)} (OID ${value.declaredOid})${underlying} without a verified pg mapping; generated as unknown.`);
      scalar = 'unknown';
    }
  }
  // unknown already includes null, including for nullable JSON and unmapped types.
  return `${scalar}${value.nullable && scalar !== 'unknown' ? ' | null' : ''}`;
}

function rowTypes(tables: readonly TableRow[], namespace: string, onWarning: (message: string) => void): string {
  const rows = tables.map(table => `  ${json(table.name)}: {\n${table.columns.map(value => `    ${json(value.name)}: ${columnType(value, `${json(namespace)}.${json(table.name)}.${json(value.name)}`, onWarning)};`).join('\n')}\n  };`);
  const aliases = tables.filter(table => canExportRowName(table.name)).map(table => `export type ${table.name} = Rows[${json(table.name)}];`);
  const arrays = tables.some(table => table.columns.some(isSupportedArray))
    ? 'export type PgArray<T> = (T | null | PgArray<T>)[];\n\n' : '';
  return `${arrays}// Full database rows. Compose query types with Pick, indexed access, and intersections.\nexport type Rows = {\n${rows.join('\n')}\n};\n${aliases.join('\n')}\n`;
}

/** Read-only introspection. Output needs no runtime imports or schema registration. */
export async function generateDefinitions(options: GenerateOptions): Promise<string> {
  const onWarning = options.onWarning ?? ((message: string) => console.warn(`Warning: ${message}`));
  const migrations = await readMigrations(options.directory);
  return withToolConnection(options, true, async (client, namespace) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Keep catalog deparsing stable across connection settings and replay schemas.
    // Transaction-local settings are restored before returning a borrowed client.
    await client.query(`SET LOCAL search_path TO pg_catalog, ${quote(namespace)}`);
    await client.query('SET LOCAL quote_all_identifiers TO off');
    await client.query('SET LOCAL standard_conforming_strings TO on');
    const applied = await migrationState(client, namespace, migrations);
    if (applied.length !== migrations.length) onWarning(`${migrations.length - applied.length} pending migration(s); generating definitions for the current database schema after ${applied.at(-1)?.id ?? 'no applied migrations'}.`);
    const tables = await client.query<{ oid: string; name: string }>(`
      SELECT c.oid::text AS oid, c.relname AS name
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname <> $2 AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
      ORDER BY c.relname COLLATE "C"`, [namespace, migrationTable]);
    const definitions: TableRow[] = [];
    const summaries: string[] = [];
    for (const table of tables.rows) {
      // Attached descendants are storage details, not separate generated models.
      const columns = await client.query<ColumnRow>(`
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
        WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [table.oid]);
      definitions.push({ name: table.name, columns: columns.rows });
      summaries.push(await tableSummary(client, table.oid, table.name));
    }
    const domains = await domainSummaries(client, definitions.flatMap(table => table.columns.map(column => column.declaredOid)));
    const types = rowTypes(definitions, namespace, onWarning);
    await client.query('COMMIT');
    return `// Generated by Tenon from the PostgreSQL schema at migrationHistory below. Do not edit.\n// Commit this file; production migration commands do not regenerate it.\n\n${schemaSummary([...domains, ...summaries])}export const migrationHistory = ${json(applied.map(m => ({ id: m.id, checksum: m.checksum })))} as const;\n\n${types}`;
  });
}
