import type { ColumnRow, TableRow } from './catalog.js';

// Every generated table remains accessible through Rows["exact SQL name"].
const reservedTypeNames = new Set(
  `
  as await break case catch class const continue debugger default delete do else enum
  export extends false finally for function if implements import in instanceof
  interface let new null package private protected public return static super
  switch this throw true try typeof var void while with yield any bigint boolean
  intrinsic never number object string symbol undefined unknown
  Rows globalThis PgArray
`
    .trim()
    .split(/\s+/),
);

function canExportRowName(name: string): boolean {
  return (
    /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(name) && !reservedTypeNames.has(name)
  );
}

type ValueTypes = Readonly<{ read: string; write: string }>;
type TypeMapping = string | ValueTypes;

// A string means the read and write representations match. Arrays use verified
// built-in OIDs because their parsers can differ from scalar parsers (numeric[]).
const arrayTypes: Readonly<Record<string, TypeMapping>> = {
  '1000': 'boolean',
  '1001': 'import("node:buffer").Buffer',
  '1005': 'number',
  '1007': 'number',
  '1021': 'number',
  '1022': 'number',
  '1028': 'number',
  '1016': { read: 'string', write: 'string | bigint' },
  '1231': { read: 'number', write: 'string | number' },
  '1009': 'string',
  '1014': 'string',
  '1015': 'string',
  '1183': 'string',
  '1270': 'string',
  '2951': 'string',
  '1182': { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  '1115': { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  '1185': { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  '199': { read: 'unknown', write: 'string' },
  '3807': { read: 'unknown', write: 'string' },
};
const scalarTypes: Readonly<Record<string, TypeMapping>> = {
  int2: 'number',
  int4: 'number',
  oid: 'number',
  float4: 'number',
  float8: 'number',
  bool: 'boolean',
  text: 'string',
  name: 'string',
  varchar: 'string',
  bpchar: 'string',
  time: 'string',
  timetz: 'string',
  uuid: 'string',
  // pg returns +/-Infinity as numbers. TypeScript has no infinity literal type.
  date: { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  timestamp: { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  timestamptz: { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  int8: { read: 'string', write: 'string | bigint' },
  numeric: { read: 'string', write: 'string | number' },
  json: { read: 'unknown', write: 'string' },
  jsonb: { read: 'unknown', write: 'string' },
  bytea: 'import("node:buffer").Buffer',
};

function valueTypes(mapping: TypeMapping): ValueTypes {
  return typeof mapping === 'string' ? { read: mapping, write: mapping } : mapping;
}

function isSupportedArray(value: ColumnRow): boolean {
  return Object.hasOwn(arrayTypes, value.oid);
}

function columnTypes(
  value: ColumnRow,
  column: string,
  onWarning: (message: string) => void,
): ValueTypes {
  let types: ValueTypes;
  if (isSupportedArray(value)) {
    const element = valueTypes(arrayTypes[value.oid]!);
    types = { read: `PgArray<${element.read}>`, write: `PgArray<${element.write}>` };
  } else if (value.typeKind === 'e') {
    const choice = value.choices?.map((choice) => JSON.stringify(choice)).join(' | ') || 'never';
    types = { read: choice, write: choice };
  } else {
    const type =
      value.typeSchema === 'pg_catalog' && Object.hasOwn(scalarTypes, value.type)
        ? scalarTypes[value.type]
        : undefined;
    if (type) {
      types = valueTypes(type);
    } else {
      const underlying =
        value.declaredOid === value.oid
          ? ''
          : ` with underlying type ${JSON.stringify(value.typeSchema)}.${JSON.stringify(value.type)} (OID ${value.oid})`;
      onWarning(
        `Column ${column} uses PostgreSQL type ${JSON.stringify(value.declaredSchema)}.${JSON.stringify(value.declaredType)} (OID ${value.declaredOid})${underlying} without a verified pg mapping; generated as unknown for reads and never for non-null writes.`,
      );
      types = { read: 'unknown', write: 'never' };
    }
  }
  // unknown already includes null, including for nullable JSON and unmapped types.
  return {
    read: `${types.read}${value.nullable && types.read !== 'unknown' ? ' | null' : ''}`,
    write: `${types.write}${value.writeNullable ? ' | null' : ''}`,
  };
}

export function renderTableTypes(
  tables: readonly TableRow[],
  namespace: string,
  onWarning: (message: string) => void,
): string {
  const definitions = tables.map((table) => {
    const tableName = JSON.stringify(table.name);
    const columns = table.columns.map((column) => {
      const columnName = JSON.stringify(column.name);
      const path = `${JSON.stringify(namespace)}.${tableName}.${columnName}`;
      const types = columnTypes(column, path, onWarning);
      const requiredOnInsert = column.writable && !column.hasDefault && !column.writeNullable;
      const optionalInputType = column.writable ? `${types.write} | undefined` : 'never';
      return {
        row: `    ${columnName}: ${types.read};`,
        insert: `    ${columnName}${requiredOnInsert ? '' : '?'}: ${requiredOnInsert ? types.write : optionalInputType};`,
        update: `    ${columnName}?: ${optionalInputType};`,
      };
    });
    return { tableName, columns };
  });
  const render = (kind: 'row' | 'insert' | 'update', indent = '') =>
    definitions
      .map(
        ({ tableName, columns }) => `${indent}  ${tableName}: {
${columns.map((column) => indent + column[kind]).join('\n')}
${indent}  };`,
      )
      .join('\n');
  const aliases = tables
    .filter((table) => canExportRowName(table.name))
    .map((table) => `export type ${table.name} = Rows[${JSON.stringify(table.name)}];`);
  const arrays = tables.some((table) => table.columns.some(isSupportedArray))
    ? 'export type PgArray<T> = (T | null | PgArray<T>)[];\n\n'
    : '';
  return `${arrays}// Full database rows. Compose query types with Pick, indexed access, and intersections.
export type Rows = {
${render('row')}
};

export declare namespace Rows {
  // Bound inputs for sql.insertValues. Missing/undefined fields use database defaults.
  type Insert = {
${render('insert', '  ')}
  };

  // Bound inputs for sql.assignments. Missing/undefined fields are omitted.
  type Update = {
${render('update', '  ')}
  };
}
${aliases.join('\n')}
`;
}
