import { TenonError } from '../errors.js';
import type { ColumnRow, TableRow } from './catalog.js';

// Every generated table remains accessible through Rows["exact SQL name"].
const reservedTypeNames = new Set(
  `
  await break case catch class const continue debugger default delete do else enum
  export extends false finally for function if implements import in instanceof
  interface let new null package private protected public return static super
  switch this throw true try typeof var void while with yield any bigint boolean
  intrinsic never number object string symbol undefined unknown
  Rows migrationHistory globalThis PgArray
`
    .trim()
    .split(/\s+/),
);

function canExportRowName(name: string): boolean {
  return (
    /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(name) && !reservedTypeNames.has(name)
  );
}

// Exact built-in OIDs with verified default pg text parsers. Array parsers do
// not necessarily use their scalar type's representation (notably numeric[]).
const arrayTypes: Readonly<Record<string, string>> = {
  '1000': 'boolean',
  '1001': 'import("node:buffer").Buffer',
  '1007': 'number',
  '1016': 'string',
  '1231': 'number',
  '1009': 'string',
  '1015': 'string',
  '2951': 'string',
  '1185': 'globalThis.Date',
  '199': 'unknown',
  '3807': 'unknown',
};
const scalarTypes: Readonly<Record<string, string>> = {
  int4: 'number',
  bool: 'boolean',
  text: 'string',
  varchar: 'string',
  uuid: 'string',
  timestamptz: 'globalThis.Date',
  int8: 'string',
  numeric: 'string',
  json: 'unknown',
  jsonb: 'unknown',
  bytea: 'import("node:buffer").Buffer',
};

function isSupportedArray(value: ColumnRow): boolean {
  return Object.hasOwn(arrayTypes, value.oid);
}

function columnType(
  value: ColumnRow,
  column: string,
  onWarning: (message: string) => void,
): string {
  let scalar: string;
  if (isSupportedArray(value)) {
    scalar = `PgArray<${arrayTypes[value.oid]!}>`;
  } else if (value.typeKind === 'e') {
    if (!value.choices?.length) {
      throw new TenonError(`Empty enum for ${value.name}`);
    }
    scalar = value.choices.map((choice) => JSON.stringify(choice)).join(' | ');
  } else {
    const type =
      value.typeSchema === 'pg_catalog' && Object.hasOwn(scalarTypes, value.type)
        ? scalarTypes[value.type]
        : undefined;
    if (type) {
      scalar = type;
    } else {
      const underlying =
        value.declaredOid === value.oid
          ? ''
          : ` with underlying type ${JSON.stringify(value.typeSchema)}.${JSON.stringify(value.type)} (OID ${value.oid})`;
      onWarning(
        `Column ${column} uses PostgreSQL type ${JSON.stringify(value.declaredSchema)}.${JSON.stringify(value.declaredType)} (OID ${value.declaredOid})${underlying} without a verified pg mapping; generated as unknown.`,
      );
      scalar = 'unknown';
    }
  }
  // unknown already includes null, including for nullable JSON and unmapped types.
  return `${scalar}${value.nullable && scalar !== 'unknown' ? ' | null' : ''}`;
}

export function renderRowTypes(
  tables: readonly TableRow[],
  namespace: string,
  onWarning: (message: string) => void,
): string {
  const rows = tables.map((table) => {
    const tableName = JSON.stringify(table.name);
    const columns = table.columns.map((column) => {
      const columnName = JSON.stringify(column.name);
      const path = `${JSON.stringify(namespace)}.${tableName}.${columnName}`;
      return `    ${columnName}: ${columnType(column, path, onWarning)};`;
    });
    return `  ${tableName}: {
${columns.join('\n')}
  };`;
  });
  const aliases = tables
    .filter((table) => canExportRowName(table.name))
    .map((table) => `export type ${table.name} = Rows[${JSON.stringify(table.name)}];`);
  const arrays = tables.some((table) => table.columns.some(isSupportedArray))
    ? 'export type PgArray<T> = (T | null | PgArray<T>)[];\n\n'
    : '';
  return `${arrays}// Full database rows. Compose query types with Pick, indexed access, and intersections.
export type Rows = {
${rows.join('\n')}
};
${aliases.join('\n')}
`;
}
