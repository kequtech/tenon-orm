import type { QueryResultRow } from 'pg';
import { quote } from './sql.js';

// Shared symbols let separately installed copies exchange queries and identifiers.
const queryTag = Symbol.for('@kequtech/tenon-orm/query');
const identifierTag = Symbol.for('@kequtech/tenon-orm/identifier');
export type UnknownRow = Record<string, unknown>;

/** A parameterized statement. The row type describes one returned record. */
export interface SqlQuery<Row extends QueryResultRow = UnknownRow> {
  readonly text: string;
  readonly values: readonly unknown[];
  /** Type-only field; a stable key preserves row inference across package copies. */
  readonly __rowType?: Row;
}

interface Identifier {
  readonly names: readonly string[];
}

/** Quote identifier components separately; ordinary interpolations always bind values. */
export function identifier(...names: string[]): Identifier {
  if (!names.length) throw new Error('An identifier needs at least one name.');
  names.forEach(quote);
  return Object.freeze({ [identifierTag]: true as const, names: Object.freeze([...names]) });
}

/** Each interpolation is a value parameter, except an explicitly quoted identifier. */
export function sql<Row extends QueryResultRow = UnknownRow>(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): NoInfer<SqlQuery<Row>> {
  if (
    !Array.isArray(strings) ||
    !Array.isArray(strings.raw) ||
    strings.length !== values.length + 1 ||
    strings.some((chunk) => typeof chunk !== 'string')
  ) {
    throw new Error('sql must be used as a template tag.');
  }
  const parameters: unknown[] = [];
  let text = strings[0]!;
  for (const [i, value] of values.entries()) {
    if (
      value &&
      typeof value === 'object' &&
      identifierTag in value &&
      value[identifierTag] === true
    ) {
      if (!('names' in value) || !Array.isArray(value.names) || !value.names.length) {
        throw new Error('An identifier needs at least one name.');
      }
      text += value.names.map(quote).join('.');
    } else {
      if (value && typeof value === 'object' && queryTag in value && value[queryTag] === true) {
        throw new Error('Nested SQL queries are not supported; interpolate values or identifiers.');
      }
      parameters.push(value);
      text += '$' + parameters.length;
    }
    text += strings[i + 1]!;
  }
  return unsafeSql<Row>(text, parameters);
}

/** Escape hatch for externally authored SQL. Never concatenate application input into text. */
export function unsafeSql<Row extends QueryResultRow = UnknownRow>(
  text: string,
  values: readonly unknown[],
): NoInfer<SqlQuery<Row>> {
  if (typeof text !== 'string' || !text.trim()) throw new Error('SQL must be a nonempty string.');
  if (!Array.isArray(values)) throw new Error('SQL input must be an explicit array.');
  return Object.freeze({ [queryTag]: true as const, text, values: Object.freeze([...values]) });
}

export function assertQuery(value: unknown): asserts value is SqlQuery {
  if (
    !value ||
    typeof value !== 'object' ||
    !(queryTag in value) ||
    value[queryTag] !== true ||
    !('text' in value) ||
    typeof value.text !== 'string' ||
    !value.text.trim() ||
    !('values' in value) ||
    !Array.isArray(value.values)
  ) {
    throw new Error('Expected a query created with sql or unsafeSql.');
  }
}
