import { plainObject } from '../validation.js';
import { checkTextArrayKey } from './check-equivalence.js';
import type {
  SchemaAcceptedDifference,
  SchemaComparison,
  SchemaComparisonOptions,
  SchemaDifference,
  SchemaMetadata,
  SchemaValue,
} from './types.js';

function record(value: SchemaValue | undefined): value is { readonly [key: string]: SchemaValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function namedCollection(path: readonly (string | number)[]): boolean {
  return (
    (path.length === 1 && ['tables', 'enums', 'domains', 'sequences'].includes(String(path[0]))) ||
    (path.length === 3 &&
      ((path[0] === 'tables' && ['columns', 'constraints', 'indexes'].includes(String(path[2]))) ||
        (path[0] === 'domains' && path[2] === 'constraints')))
  );
}

function named(values: readonly SchemaValue[]): Map<string, SchemaValue> {
  const result = new Map<string, SchemaValue>();
  for (const value of values) {
    if (!record(value) || typeof value.name !== 'string')
      throw new Error('Schema collections require objects with string names.');
    if (result.has(value.name)) throw new Error(`Duplicate schema object name: ${value.name}`);
    result.set(value.name, value);
  }
  return result;
}

/** Compare metadata rather than trusting fingerprints; v1 snapshots remain unchanged. */
export function compareSchemas(
  expected: SchemaMetadata,
  actual: SchemaMetadata,
  options: SchemaComparisonOptions = {},
): SchemaComparison {
  for (const [key, value] of Object.entries(plainObject(options, 'Schema comparison options'))) {
    if (!['ignorePostgresMajor', 'normalizeCheckTextArrayCasts'].includes(key))
      throw new Error(`Unknown schema comparison option: ${key}`);
    if (typeof value !== 'boolean') throw new Error(`Schema comparison ${key} must be boolean.`);
  }
  for (const metadata of [expected, actual]) {
    const object = plainObject(metadata, 'Schema metadata');
    if (object.formatVersion !== 1) throw new Error('Schema comparison requires formatVersion 1.');
    if (typeof object.namespace !== 'string' || !Number.isInteger(object.postgresMajor))
      throw new Error('Schema comparison requires namespace and postgresMajor.');
    for (const key of ['tables', 'enums', 'domains', 'sequences'])
      if (!Array.isArray(object[key])) throw new Error(`Schema comparison requires ${key}.`);
  }
  const differences: SchemaDifference[] = [];
  const acceptedDifferences: SchemaAcceptedDifference[] = [];
  function visit(
    before: SchemaValue | undefined,
    after: SchemaValue | undefined,
    path: readonly (string | number)[],
  ): void {
    if (before === after) return;
    if (Array.isArray(before) && Array.isArray(after)) {
      if (namedCollection(path)) {
        const left = named(before);
        const right = named(after);
        // Collection order is immaterial except for physical column order.
        if (
          path[2] === 'columns' &&
          left.size === right.size &&
          [...left.keys()].every((name) => right.has(name))
        ) {
          const orderBefore = [...left.keys()];
          const orderAfter = [...right.keys()];
          if (orderBefore.some((name, i) => name !== orderAfter[i]))
            differences.push({
              kind: 'changed',
              path: [...path, 'order'],
              expected: orderBefore,
              actual: orderAfter,
            });
        }
        for (const name of [...new Set([...left.keys(), ...right.keys()])].sort())
          visit(left.get(name), right.get(name), [...path, name]);
      } else {
        for (let i = 0; i < Math.max(before.length, after.length); i++)
          visit(before[i], after[i], [...path, i]);
      }
      return;
    }
    if (record(before) && record(after)) {
      for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
        if (!path.length && key === 'fingerprint') continue;
        visit(
          Object.hasOwn(before, key) ? before[key] : undefined,
          Object.hasOwn(after, key) ? after[key] : undefined,
          [...path, key],
        );
      }
      return;
    }
    const difference: SchemaDifference = {
      kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
      path,
      ...(before === undefined ? {} : { expected: before }),
      ...(after === undefined ? {} : { actual: after }),
    };
    if (path.length === 1 && path[0] === 'postgresMajor' && options.ignorePostgresMajor) {
      acceptedDifferences.push({ ...difference, reason: 'postgres-major' });
      return;
    }
    if (
      options.normalizeCheckTextArrayCasts &&
      path.length === 5 &&
      ['tables', 'domains'].includes(String(path[0])) &&
      path[2] === 'constraints' &&
      path[4] === 'definition' &&
      typeof before === 'string' &&
      typeof after === 'string'
    ) {
      const key = checkTextArrayKey(before);
      if (key !== undefined && key === checkTextArrayKey(after)) {
        acceptedDifferences.push({ ...difference, reason: 'check-text-array-casts' });
        return;
      }
    }
    differences.push(difference);
  }
  visit(expected as unknown as SchemaValue, actual as unknown as SchemaValue, []);
  return { equivalent: differences.length === 0, differences, acceptedDifferences };
}
