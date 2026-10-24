import { quote } from './sql.js';
import { plainObject } from './validation.js';

export type MutationPart = string | Readonly<{ value: unknown }>;
export type MutationColumns<Input> = Input extends object ? Extract<keyof Input, string> : never;

/** Validate and quote one explicit column list, shared by runtime and SQL checking. */
export function mutationColumns(columns: readonly string[]): string[] {
  if (!Array.isArray(columns) || !columns.length)
    throw new Error('Mutation columns must be a nonempty array.');
  const seen = new Set<string>();
  return Array.from(columns, (column) => {
    if (typeof column !== 'string') throw new Error('Mutation column names must be strings.');
    quote(column);
    if (seen.has(column)) throw new Error(`Duplicate mutation column ${JSON.stringify(column)}.`);
    seen.add(column);
    return column;
  });
}

/** SQL structure depends only on these columns and cells, never on JavaScript source. */
export function insertLayout(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): MutationPart[] {
  if (!rows.length) throw new Error('sql.insertValues requires at least one row.');
  if (!columns.length) {
    if (rows.length !== 1) throw new Error('Default-only inserts require exactly one row.');
    return ['DEFAULT VALUES'];
  }
  const parts: MutationPart[] = [`(${columns.map(quote).join(', ')}) VALUES `];
  for (const [index, row] of rows.entries()) {
    if (index) parts.push(', ');
    parts.push('(');
    for (const [column, value] of row.entries()) {
      if (column) parts.push(', ');
      parts.push(value === undefined ? 'DEFAULT' : Object.freeze({ value }));
    }
    parts.push(')');
  }
  return parts;
}

export function assignmentLayout(
  columns: readonly string[],
  values: readonly unknown[],
): MutationPart[] {
  const parts: MutationPart[] = [];
  for (const [index, column] of columns.entries()) {
    const value = values[index];
    if (value === undefined) continue;
    if (parts.length) parts.push(', ');
    parts.push(`${quote(column)} = `, Object.freeze({ value }));
  }
  if (!parts.length) throw new Error('sql.assignments requires at least one defined field.');
  return parts;
}

function record(value: unknown, helper: string, index: number): object {
  return plainObject(value, `${helper} row ${index + 1}`);
}

function cell(row: object, column: string, helper: string, index: number): unknown {
  const property = Object.getOwnPropertyDescriptor(row, column);
  if (!property) return undefined;
  if (!('value' in property))
    throw new Error(
      `${helper} row ${index + 1} column ${JSON.stringify(column)} must be a data property.`,
    );
  const value: unknown = property.value;
  if (
    value &&
    typeof value === 'object' &&
    ['fragment', 'identifier', 'query'].some(
      (kind) => Symbol.for(`@kequtech/tenon-orm/${kind}`) in value,
    )
  ) {
    throw new Error(
      `${helper} row ${index + 1} column ${JSON.stringify(column)} expects a bound value; put SQL expressions in the surrounding statement.`,
    );
  }
  return value;
}

export function insertParts(
  input: object | readonly object[],
  selected?: readonly string[],
): MutationPart[] {
  const rows = Array.from(Array.isArray(input) ? input : [input], (row, index) =>
    record(row, 'sql.insertValues', index),
  );
  if (!rows.length) throw new Error('sql.insertValues requires at least one row.');
  const columns =
    selected === undefined
      ? [
          ...new Set(
            rows.flatMap((row, index) =>
              Object.keys(row).filter(
                (column) => cell(row, column, 'sql.insertValues', index) !== undefined,
              ),
            ),
          ),
        ]
      : mutationColumns(selected);
  return insertLayout(
    columns,
    rows.map((row, index) => columns.map((column) => cell(row, column, 'sql.insertValues', index))),
  );
}

export function assignmentParts(input: object, selected?: readonly string[]): MutationPart[] {
  const row = record(input, 'sql.assignments', 0);
  const columns = selected === undefined ? Object.keys(row) : mutationColumns(selected);
  return assignmentLayout(
    columns,
    columns.map((column) => cell(row, column, 'sql.assignments', 0)),
  );
}
