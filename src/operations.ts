import type { QueryResult, QueryResultRow } from 'pg';
import { TenonError } from './errors.js';
import { record } from './sql.js';

const definition = Symbol('Tenon operation');
declare const operationTypes: unique symbol;

export type OperationReturnMode = 'native' | 'many' | 'one' | 'requiredOne';

/** Carries the derived output type and parameters in $1, $2, … order. */
export interface OperationDefinition<Output extends object | undefined = object | undefined, Input extends readonly unknown[] = readonly unknown[]> {
  readonly sql: string;
  readonly returns: OperationReturnMode;
  readonly [definition]: true;
  readonly [operationTypes]?: { readonly output: Output; readonly input: Input };
}

export type OperationRegistry = Readonly<Record<string, OperationDefinition>>;
export type EmptyOperations = Record<never, never>;
type OperationInput<D> = D extends OperationDefinition<object | undefined, infer Input> ? Input : never;
type OperationOutput<D> = D extends OperationDefinition<infer Output, readonly unknown[]> ? Output : never;

export interface OperationClient<O extends OperationRegistry> {
  run<K extends keyof O & string>(name: K, input: Readonly<OperationInput<O[NoInfer<K>]>>): Promise<OperationOutput<O[K]>>;
}

export interface ResultOptions {
  readonly returns?: OperationReturnMode;
}

/** Row describes one SQL record; returns determines its surrounding result shape. */
// NoInfer keeps a registry's context from silently supplying omitted contracts.
export function define<Row extends QueryResultRow = never, Input extends readonly unknown[] = []>(sql: string, options?: { readonly returns?: 'native' }): NoInfer<OperationDefinition<QueryResult<Row>, Input>>;
export function define<Row extends QueryResultRow = never, Input extends readonly unknown[] = []>(sql: string, options: { readonly returns: 'many' }): NoInfer<OperationDefinition<Row[], Input>>;
export function define<Row extends QueryResultRow = never, Input extends readonly unknown[] = []>(sql: string, options: { readonly returns: 'one' }): NoInfer<OperationDefinition<Row | undefined, Input>>;
export function define<Row extends QueryResultRow = never, Input extends readonly unknown[] = []>(sql: string, options: { readonly returns: 'requiredOne' }): NoInfer<OperationDefinition<Row, Input>>;
export function define(sql: string, options?: ResultOptions): OperationDefinition {
  return createOperation(sql, options);
}

/** Shared runtime validation for inline SQL and registered definitions. */
export function createOperation(sql: string, options?: ResultOptions): OperationDefinition {
  if (typeof sql !== 'string' || !sql.trim()) throw new TenonError('Operation SQL must be a nonempty string.');
  const config = options === undefined ? {} : record(options, 'Operation options');
  for (const key of Object.keys(config)) if (key !== 'returns') throw new TenonError(`Unknown operation option: ${key}`);
  const returns = config.returns === undefined ? 'native' : config.returns;
  if (returns !== 'many' && returns !== 'one' && returns !== 'requiredOne' && returns !== 'native') {
    throw new TenonError('Operation returns must be native, many, one, or requiredOne.');
  }
  return Object.freeze({ sql, returns, [definition]: true as const });
}

export function operationResult(name: string, operation: OperationDefinition, result: QueryResult<Record<string, unknown>>): object | undefined {
  if (operation.returns === 'native') return result;
  const rows = result.rows;
  if (operation.returns === 'many') return rows;
  const expected = operation.returns === 'one' ? 'at most one row' : 'exactly one row';
  if (rows.length > 1 || (operation.returns === 'requiredOne' && rows.length === 0)) {
    throw new TenonError(`Operation ${name} expected ${expected}, but returned ${rows.length} rows.`);
  }
  return rows[0];
}

/** Capture registrations once; definitions can be imported from any module. */
export function inspectOperations(operations: OperationRegistry): ReadonlyMap<string, OperationDefinition> {
  const result = new Map<string, OperationDefinition>();
  for (const [name, value] of Object.entries(record(operations, 'operations'))) {
    if (!name.trim() || name.includes('\0')) throw new TenonError('Operation names must be nonempty and contain no NUL character.');
    if (!value || typeof value !== 'object' || !(definition in value) || value[definition] !== true) {
      throw new TenonError(`Operation ${name} must be created with define().`);
    }
    result.set(name, value as OperationDefinition);
  }
  return result;
}
