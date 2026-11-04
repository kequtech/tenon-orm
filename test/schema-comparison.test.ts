import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSchemas, type SchemaSnapshot } from '../src/index.js';

const original = `CHECK ((("status")::"text" = ANY ((ARRAY['active'::character varying, 'disabled'::character varying, 'retired'::character varying])::"text"[])))`;
const replayed = `CHECK ((("status")::"text" = ANY (ARRAY[('active'::character varying)::"text", ('disabled'::character varying)::"text", ('retired'::character varying)::"text"])))`;
const normalize = { normalizeCheckTextArrayCasts: true };

function snapshot(definition = original): SchemaSnapshot {
  return {
    formatVersion: 1,
    postgresMajor: 17,
    namespace: 'app',
    fingerprint: 'opaque',
    tables: [
      {
        name: 'records.with.dots',
        kind: 'r',
        persistence: 'p',
        parents: [],
        partitionKey: null,
        partitionBound: null,
        columns: ['status', 'other'].map((name) => ({
          name,
          type: 'character varying(16)',
          nullable: true,
          expression: null,
          identity: '',
          generated: '',
          collation: null,
        })),
        constraints: [{ name: 'status_check', definition }],
        indexes: [],
      },
    ],
    enums: [{ name: 'state', labels: ['active', 'disabled'] }],
    domains: [],
    sequences: [],
  };
}

test('schema comparison reports named object/property paths and expected/actual values', () => {
  const expected = snapshot();
  const actual: SchemaSnapshot = {
    ...expected,
    fingerprint: 'opaque',
    tables: [
      {
        ...expected.tables[0]!,
        columns: [
          { ...expected.tables[0]!.columns[0]!, nullable: false },
          { ...expected.tables[0]!.columns[1]!, name: 'added' },
        ],
        constraints: [],
      },
    ],
    enums: [{ name: 'state', labels: ['disabled', 'active'] }],
  };
  assert.deepEqual(compareSchemas(expected, actual), {
    equivalent: false,
    acceptedDifferences: [],
    differences: [
      {
        kind: 'changed',
        path: ['enums', 'state', 'labels', 0],
        expected: 'active',
        actual: 'disabled',
      },
      {
        kind: 'changed',
        path: ['enums', 'state', 'labels', 1],
        expected: 'disabled',
        actual: 'active',
      },
      {
        kind: 'added',
        path: ['tables', 'records.with.dots', 'columns', 'added'],
        actual: actual.tables[0]!.columns[1],
      },
      {
        kind: 'removed',
        path: ['tables', 'records.with.dots', 'columns', 'other'],
        expected: expected.tables[0]!.columns[1],
      },
      {
        kind: 'changed',
        path: ['tables', 'records.with.dots', 'columns', 'status', 'nullable'],
        expected: true,
        actual: false,
      },
      {
        kind: 'removed',
        path: ['tables', 'records.with.dots', 'constraints', 'status_check'],
        expected: expected.tables[0]!.constraints[0],
      },
    ],
  });
  const changedFingerprint: SchemaSnapshot = { ...expected, fingerprint: 'ignored' };
  assert.equal(compareSchemas(expected, changedFingerprint).equivalent, true);
  assert.equal(
    compareSchemas(expected, actual).differences.length,
    6,
    'equal fingerprints cannot bypass metadata',
  );
});

test('text-array cast equivalence is opt-in and retains raw accepted differences', () => {
  const expected = snapshot();
  const actual = snapshot(replayed);
  const raw = compareSchemas(expected, actual);
  assert.equal(raw.equivalent, false);
  assert.deepEqual(raw.differences, [
    {
      kind: 'changed',
      path: ['tables', 'records.with.dots', 'constraints', 'status_check', 'definition'],
      expected: original,
      actual: replayed,
    },
  ]);
  assert.deepEqual(compareSchemas(expected, actual, normalize), {
    equivalent: true,
    differences: [],
    acceptedDifferences: [{ ...raw.differences[0], reason: 'check-text-array-casts' }],
  });
  assert.equal(compareSchemas(actual, expected, normalize).equivalent, true);
  assert.equal(expected.tables[0]!.constraints[0]!.definition, original);
});

test('major differences require an independent option and never conceal other changes', () => {
  const expected = snapshot();
  const actual = { ...snapshot(replayed), postgresMajor: 16 };
  assert.deepEqual(compareSchemas(expected, actual, normalize).differences, [
    { kind: 'changed', path: ['postgresMajor'], expected: 17, actual: 16 },
  ]);
  const comparison = compareSchemas(expected, actual, { ...normalize, ignorePostgresMajor: true });
  assert.equal(comparison.equivalent, true);
  assert.deepEqual(
    comparison.acceptedDifferences.map((difference) => difference.reason),
    ['postgres-major', 'check-text-array-casts'],
  );
  assert.equal(
    compareSchemas(
      expected,
      { ...actual, namespace: 'elsewhere' },
      {
        ...normalize,
        ignorePostgresMajor: true,
      },
    ).equivalent,
    false,
  );
});

test('normalization preserves literal, operator, operand, cast, collation and validation differences', () => {
  for (const changed of [
    replayed.replace('disabled', 'pending'),
    replayed.replace('status', 'other'),
    replayed.replace('= ANY', '<> ANY'),
    replayed.replace('= ANY', '<> ALL'),
    replayed.replace('character varying', 'character varying(3)'),
    replayed.replace('character varying', 'character'),
    replayed.replace('character varying', '"app"."varchar"'),
    replayed.replace('("status")::"text"', '("status")::"text" COLLATE "C"'),
    replayed + ' NOT VALID',
    replayed + ' NO INHERIT',
    replayed.replace("'active'", "'Active'"),
    replayed.replace("'active'", 'NULL'),
    replayed.replace("'active'", "lower('active')"),
    replayed.replace("'active'", "E'active'"),
    replayed.replace('CHECK (', 'CHECK (false AND '),
  ]) {
    const comparison = compareSchemas(snapshot(), snapshot(changed), normalize);
    assert.equal(comparison.equivalent, false, changed);
    assert.equal(comparison.differences.length, 1);
    assert.deepEqual(comparison.acceptedDifferences, []);
  }
  // Text inside literals and identifiers must never be treated as SQL syntax.
  for (const literal of ["'a''b'", "'x,ARRAY[(::text[])'", "'\\value'", "'☃'"]) {
    const before = original.replace("'active'", literal);
    const after = replayed.replace("'active'", literal);
    assert.equal(compareSchemas(snapshot(before), snapshot(after), normalize).equivalent, true);
    assert.equal(
      compareSchemas(snapshot(before), snapshot(after.replace(literal, "'different'")), normalize)
        .equivalent,
      false,
    );
  }
  const quotedBefore = original.replace('"status"', '"status::ARRAY["');
  const quotedAfter = replayed.replace('"status"', '"status::ARRAY["');
  assert.equal(
    compareSchemas(snapshot(quotedBefore), snapshot(quotedAfter), normalize).equivalent,
    true,
  );
});

test('only constraint definitions are normalized; named collections preserve column and label order', () => {
  const expected = snapshot();
  const table = expected.tables[0]!;
  const reordered = { ...expected, tables: [{ ...table, columns: [...table.columns].reverse() }] };
  assert.deepEqual(compareSchemas(expected, reordered).differences, [
    {
      kind: 'changed',
      path: ['tables', table.name, 'columns', 'order'],
      expected: ['status', 'other'],
      actual: ['other', 'status'],
    },
  ]);
  const additional = { ...table, name: 'another' };
  assert.equal(
    compareSchemas(
      { ...expected, tables: [table, additional] },
      {
        ...expected,
        tables: [additional, table],
      },
    ).equivalent,
    true,
  );
  const expression = (value: string): SchemaSnapshot => ({
    ...expected,
    tables: [{ ...table, columns: [{ ...table.columns[0]!, expression: value }] }],
  });
  assert.equal(
    compareSchemas(expression(original), expression(replayed), normalize).equivalent,
    false,
  );
});

test('malformed comparison contracts fail explicitly', () => {
  const expected = snapshot();
  assert.throws(
    () => compareSchemas({ ...expected, formatVersion: 2 } as never, expected),
    /formatVersion/,
  );
  assert.throws(
    () => compareSchemas({ ...expected, tables: undefined } as never, expected),
    /tables/,
  );
  assert.throws(
    () => compareSchemas(expected, expected, { unknown: true } as never),
    /Unknown schema comparison/,
  );
  assert.throws(
    () => compareSchemas(expected, expected, { ignorePostgresMajor: 'yes' } as never),
    /must be boolean/,
  );
  assert.throws(
    () => compareSchemas({ ...expected, enums: [...expected.enums, ...expected.enums] }, expected),
    /Duplicate/,
  );
});
