import type { QueryResultRow } from 'pg';
import { joinSeparator, quote } from './sql.js';
import {
  assignmentParts,
  insertParts,
  type MutationColumns,
  type MutationPart,
} from './mutations.js';

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

const fragmentTag = Symbol.for('@kequtech/tenon-orm/fragment');

type Part = MutationPart;

/** A composable piece of SQL, not an executable query or a result-type declaration. */
export interface SqlFragment {
  /** Stable across separately installed copies; runtime identity uses a shared symbol. */
  readonly __tenonFragment: true;
}

function fragmentParts(value: unknown): readonly Part[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !(fragmentTag in value) ||
    !Array.isArray(value[fragmentTag])
  ) {
    throw new Error('Expected a fragment created with sql.fragment or sql.join.');
  }
  return value[fragmentTag] as readonly Part[];
}

/** Preserve SQL text separately from parameters; never rewrite dollar placeholders. */
function templateParts(strings: TemplateStringsArray, values: readonly unknown[]): readonly Part[] {
  if (
    !Array.isArray(strings) ||
    !Array.isArray(strings.raw) ||
    strings.length !== values.length + 1 ||
    strings.some((chunk) => typeof chunk !== 'string')
  ) {
    throw new Error('sql and sql.fragment must be used as template tags.');
  }
  const parts: Part[] = [strings[0]!];
  for (const [i, value] of values.entries()) {
    if (value && typeof value === 'object' && fragmentTag in value) {
      for (const part of fragmentParts(value)) parts.push(part);
    } else if (
      value &&
      typeof value === 'object' &&
      identifierTag in value &&
      value[identifierTag] === true
    ) {
      if (!('names' in value) || !Array.isArray(value.names) || !value.names.length) {
        throw new Error('An identifier needs at least one name.');
      }
      parts.push(value.names.map(quote).join('.'));
    } else {
      if (value && typeof value === 'object' && queryTag in value && value[queryTag] === true) {
        throw new Error('Nested SQL queries are not supported; use sql.fragment for composition.');
      }
      parts.push(Object.freeze({ value }));
    }
    parts.push(strings[i + 1]!);
  }
  return Object.freeze(parts);
}

function fragment(strings: TemplateStringsArray, ...values: readonly unknown[]): SqlFragment {
  const parts = templateParts(strings, values);
  if (!parts.some((part) => typeof part !== 'string' || part.trim())) {
    throw new Error('SQL fragments must not be empty.');
  }
  return Object.freeze({ __tenonFragment: true as const, [fragmentTag]: parts });
}

function join(fragments: readonly SqlFragment[], separator: 'AND' | 'OR' | ','): SqlFragment {
  if (!Array.isArray(fragments) || !fragments.length) {
    throw new Error('sql.join requires at least one fragment; handle an empty list explicitly.');
  }
  const between = joinSeparator(separator);
  const parts: Part[] = [];
  for (const [i, item] of fragments.entries()) {
    if (i) parts.push(between);
    for (const part of fragmentParts(item)) parts.push(part);
  }
  return Object.freeze({ __tenonFragment: true as const, [fragmentTag]: Object.freeze(parts) });
}

/** Object fields become bound values; absent insert cells use PostgreSQL defaults. */
function insertValues<Row extends object>(
  input: Row | readonly Row[],
  columns?: readonly NoInfer<MutationColumns<Row>>[],
): SqlFragment {
  return Object.freeze({
    __tenonFragment: true as const,
    [fragmentTag]: Object.freeze(insertParts(input, columns)),
  });
}

/** Omit undefined fields; null remains a value. Empty assignments reject. */
function assignments<Row extends object>(
  input: Row,
  columns?: readonly NoInfer<MutationColumns<Row>>[],
): SqlFragment {
  return Object.freeze({
    __tenonFragment: true as const,
    [fragmentTag]: Object.freeze(assignmentParts(input, columns)),
  });
}

function createQuery<Row extends QueryResultRow = UnknownRow>(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): NoInfer<SqlQuery<Row>> {
  const parameters: unknown[] = [];
  let text = '';
  for (const part of templateParts(strings, values)) {
    if (typeof part === 'string') {
      text += part;
    } else {
      parameters.push(part.value);
      text += '$' + parameters.length;
    }
  }
  return unsafeSql<Row>(text, parameters);
}

/** Values bind parameters; identifiers quote names; fragments compose authored SQL. */
export const sql = Object.assign(createQuery, { fragment, join, insertValues, assignments });

/** Escape hatch for externally authored SQL. Never concatenate application input into text. */
export function unsafeSql<Row extends QueryResultRow = UnknownRow>(
  text: string,
  values: readonly unknown[],
): NoInfer<SqlQuery<Row>> {
  if (typeof text !== 'string' || !text.trim()) throw new Error('SQL must be a nonempty string.');
  if (!Array.isArray(values)) throw new Error('SQL input must be an explicit array.');
  if (values.length > 65535)
    throw new Error(
      'A PostgreSQL query supports at most 65535 bound parameters; split large batches explicitly.',
    );
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
