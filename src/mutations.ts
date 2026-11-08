import { param, type Codec, type Parameter } from '@kequtech/pgclear';
import { quote } from './sql.js';
import { plainObject } from './validation.js';

export type MutationPart = string | Readonly<{ value: unknown }>;
export type MutationColumns<Input> = Input extends object ? Extract<keyof Input, string> : never;

// A field's encoder must accept its raw input; its decoder does not affect this write.
type FieldCodec<Value> = Pick<Codec<unknown>, 'oid'> & {
  readonly text?: Omit<NonNullable<Codec<unknown>['text']>, 'encode'> & {
    readonly encode: (value: Value) => string;
  };
  readonly binary?: Omit<NonNullable<Codec<unknown>['binary']>, 'encode'> & {
    readonly encode: (value: Value) => Uint8Array;
  };
};

/** Encode selected raw fields with existing driver codecs. Null stays SQL NULL. */
export type MutationCodecs<Input extends object> = {
  readonly [Key in keyof Input]?: FieldCodec<Exclude<Input[Key], Parameter | null | undefined>>;
};

/** Validate own data properties once; pgclear snapshots each selected codec in param(). */
export function mutationCodecs(input: object | undefined): ReadonlyMap<string, Codec<unknown>> {
  const codecs = new Map<string, Codec<unknown>>();
  if (input === undefined) return codecs;
  for (const name of Object.keys(plainObject(input, 'Mutation codecs'))) {
    quote(name);
    const property = Object.getOwnPropertyDescriptor(input, name)!;
    if (!('value' in property) || !property.value || typeof property.value !== 'object')
      throw new Error(`Mutation codec ${JSON.stringify(name)} must be a codec data property.`);
    codecs.set(name, property.value as Codec<unknown>);
  }
  return codecs;
}

/** Validate and quote one explicit column list for mutation fragments. */
function mutationColumns(columns: readonly string[]): string[] {
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

function bound(
  value: unknown,
  column: string,
  codecs: ReadonlyMap<string, Codec<unknown>>,
): MutationPart {
  const codec = codecs.get(column);
  return Object.freeze({ value: codec ? param(value, codec) : value });
}

export function insertParts(
  input: object | readonly object[],
  selected?: readonly string[],
  codecs: ReadonlyMap<string, Codec<unknown>> = new Map(),
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
  if (!columns.length) {
    if (rows.length !== 1) throw new Error('Default-only inserts require exactly one row.');
    return ['DEFAULT VALUES'];
  }
  const parts: MutationPart[] = [`(${columns.map(quote).join(', ')}) VALUES `];
  for (const [index, row] of rows.entries()) {
    if (index) parts.push(', ');
    parts.push('(');
    for (const [position, column] of columns.entries()) {
      if (position) parts.push(', ');
      const value = cell(row, column, 'sql.insertValues', index);
      parts.push(value === undefined ? 'DEFAULT' : bound(value, column, codecs));
    }
    parts.push(')');
  }
  return parts;
}

export function assignmentParts(
  input: object,
  selected?: readonly string[],
  codecs: ReadonlyMap<string, Codec<unknown>> = new Map(),
): MutationPart[] {
  const row = record(input, 'sql.assignments', 0);
  const columns = selected === undefined ? Object.keys(row) : mutationColumns(selected);
  const parts: MutationPart[] = [];
  for (const column of columns) {
    const value = cell(row, column, 'sql.assignments', 0);
    if (value === undefined) continue;
    if (parts.length) parts.push(', ');
    parts.push(`${quote(column)} = `, bound(value, column, codecs));
  }
  if (!parts.length) throw new Error('sql.assignments requires at least one defined field.');
  return parts;
}
