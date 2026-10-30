import { defaultCodecs, type CodecRegistry } from '@kequtech/pgclear';
import type { ColumnRow, TableRow } from './catalog.js';

function columnTypes(
  column: ColumnRow,
  codecs: CodecRegistry,
  path: string,
  warn: (message: string) => void,
) {
  const oid = Number(column.oid);
  let read = codecs.typescript(oid);
  if (read === undefined) {
    warn(
      `Column ${path} uses a custom decoder without a known TypeScript representation; generated as unknown.`,
    );
    read = 'unknown';
  }
  const choices = column.choices?.map((choice) => JSON.stringify(choice)).join(' | ') || 'never';
  if (column.typeKind === 'e' && codecs.isDefaultDecoder(oid) && read === 'string') read = choices;
  let write = defaultCodecs.typescript(oid)!;
  if (column.typeKind === 'e') write = choices;
  if (write === 'unknown' || write.startsWith('PgArray<')) write = 'string';
  if ([20, 1700].includes(oid)) write += ' | bigint';
  if ([1082, 1114, 1184].includes(oid)) write += ' | globalThis.Date | TemporalInput';
  if ([1083, 1186].includes(oid)) write += ' | TemporalInput';
  // Explicit parameters handle arrays, JSON and application-owned codecs without accepting
  // ambiguous bare JS objects/arrays as ordinary binds.
  write = write === 'never' ? 'Parameter' : `${write} | Parameter`;
  return {
    read: column.nullable && read !== 'unknown' ? `(${read}) | null` : read,
    write: write + (column.writeNullable ? ' | null' : ''),
  };
}

export function renderDatabase(
  tables: readonly TableRow[],
  namespace: string,
  codecs: CodecRegistry,
  warn: (message: string) => void,
): string {
  let arrays = false,
    parameters = false,
    temporalInputs = false;
  const definitions = tables.map((table) => {
    const columns = table.columns.map((column) => {
      const name = JSON.stringify(column.name);
      const types = columnTypes(
        column,
        codecs,
        [namespace, table.name, column.name].map((value) => JSON.stringify(value)).join('.'),
        warn,
      );
      arrays ||= /\bPgArray\s*</.test(types.read);
      parameters ||= column.writable;
      temporalInputs ||= column.writable && types.write.includes('TemporalInput');
      const required = column.writable && !column.hasDefault && !column.writeNullable;
      const optional = column.writable ? `${types.write} | undefined` : 'never';
      return {
        row: `      ${name}: ${types.read};`,
        insert: `      ${name}${required ? '' : '?'}: ${required ? types.write : optional};`,
        update: `      ${name}?: ${optional};`,
      };
    });
    const shape = (kind: 'row' | 'insert' | 'update') =>
      `    ${kind}: {\n${columns.map((column) => column[kind]).join('\n')}\n    };`;
    return `  ${JSON.stringify(table.name)}: {\n${shape('row')}\n${shape('insert')}\n${shape('update')}\n  };`;
  });
  const imports = [
    ...(parameters ? ['Parameter'] : []),
    ...(arrays ? ['PgArray'] : []),
    ...(temporalInputs ? ['TemporalInput'] : []),
  ];
  const header = imports.length
    ? `import type { ${imports.join(', ')} } from '@kequtech/tenon-orm';\n\n`
    : '';
  return `${header}export type Database = {\n${definitions.join('\n')}\n};\n`;
}
