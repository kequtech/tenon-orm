import type { QueryResultRow } from 'pg';
import { TenonError } from './errors.js';
import { quote } from './sql.js';

declare const rowType: unique symbol;
export type UnknownRow = Record<string, unknown>;

/** A parameterized statement. The row type describes one returned record. */
export interface SqlQuery<Row extends QueryResultRow = UnknownRow> {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly [rowType]?: Row;
}

interface Identifier {
  readonly names: readonly string[];
}
const identifiers = new WeakSet<object>();
const queries = new WeakSet<object>();

/** Quote identifier components separately; ordinary interpolations always bind values. */
export function identifier(...names: string[]): Identifier {
  if (!names.length) throw new TenonError('An identifier needs at least one name.');
  names.forEach(quote);
  const result = Object.freeze({ names: Object.freeze([...names]) });
  identifiers.add(result);
  return result;
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
    throw new TenonError('sql must be used as a template tag.');
  }
  const parameters: unknown[] = [];
  let text = strings[0]!;
  for (const [i, value] of values.entries()) {
    if (value && typeof value === 'object' && identifiers.has(value)) {
      text += (value as Identifier).names.map(quote).join('.');
    } else {
      if (value && typeof value === 'object' && queries.has(value)) {
        throw new TenonError(
          'Nested SQL queries are not supported; interpolate values or identifiers.',
        );
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
  if (typeof text !== 'string' || !text.trim())
    throw new TenonError('SQL must be a nonempty string.');
  if (!Array.isArray(values)) throw new TenonError('SQL input must be an explicit array.');
  const result = Object.freeze({ text, values: Object.freeze([...values]) });
  queries.add(result);
  return result;
}

export function assertQuery(value: unknown): asserts value is SqlQuery {
  if (!value || typeof value !== 'object' || !queries.has(value)) {
    throw new TenonError('Expected a query created with sql or unsafeSql.');
  }
}
