import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCheckReport } from '../src/check/output.js';
import type { CheckDiagnostic, CheckReport, CheckedQuery } from '../src/check/types.js';

function report(queries: CheckedQuery[], diagnostics: CheckDiagnostic[] = []): CheckReport {
  return {
    project: '/fixture/tsconfig.json',
    ok: false,
    coverage: { total: queries.length, analysed: queries.length, unchecked: 0 },
    queries,
    diagnostics: [...diagnostics, ...queries.flatMap((query) => query.diagnostics)],
  };
}

const finding: CheckDiagnostic = {
  file: '/fixture/queries.ts',
  line: 3,
  column: 10,
  kind: 'unproven',
  code: 'result-refinement-unproven',
  resultColumn: 'state',
  expected: '"queued"',
  observed: 'string',
  message: 'A result needs refinement.',
};
const query: CheckedQuery = {
  file: finding.file,
  line: 3,
  column: 10,
  status: 'analysed',
  variants: 2,
  diagnostics: [],
};

test('readable output groups equivalent variants while retaining detailed JSON findings', () => {
  const input = report([
    {
      ...query,
      diagnostics: [
        { ...finding, variant: 1 },
        { ...finding, variant: 2 },
      ],
    },
  ]);
  const before = JSON.stringify(input);
  const output = formatCheckReport(input, { verbose: true });
  assert.equal(output.split('\n').filter((line) => line.includes(finding.code)).length, 1);
  assert.match(output, /\[variants 1, 2\]/);
  assert.match(output, /0 definite mismatches, 1 unproven findings/);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(
    input.diagnostics.map(({ variant }) => variant),
    [1, 2],
  );
});

test('grouping preserves separate columns, types, parameters, kinds, locations and query sites', () => {
  const differences: CheckDiagnostic[] = [
    finding,
    { ...finding, resultColumn: 'other' },
    { ...finding, expected: 'number' },
    { ...finding, observed: 'boolean' },
    { ...finding, parameter: 1 },
    { ...finding, parameter: 2 },
    { ...finding, kind: 'mismatch' },
    { ...finding, line: 4 },
  ];
  const output = formatCheckReport(
    report(
      [
        { ...query, diagnostics: differences },
        { ...query, line: 8, diagnostics: [finding] },
      ],
      [{ ...finding, code: 'typescript-error', kind: 'mismatch' }],
    ),
    { verbose: true },
  );
  assert.equal(output.split('\n').filter((line) => line.includes(finding.code)).length, 9);
  assert.match(output, /2 definite mismatches, 8 unproven findings/);
});

test('a clean report has a compact summary and one statement of general limits', () => {
  const output = formatCheckReport({ ...report([{ ...query, diagnostics: [] }]), ok: true });
  assert.equal(output.trim().split('\n').length, 2);
  assert.match(output, /1 queries, 1 analysed, 0 unchecked; 0 definite mismatches/);
});

test('default output summarizes nonblocking reasons without suppressing failures or changing JSON', () => {
  const input = report([
    {
      ...query,
      diagnostics: [
        finding,
        { ...finding, line: 8 },
        {
          ...finding,
          kind: 'unchecked',
          code: 'dynamic-fragments',
          message: 'Use fixed branches or test runtime composition.',
        },
        {
          ...finding,
          kind: 'mismatch',
          code: 'result-type-mismatch',
          message: 'Definite type mismatch',
        },
      ],
    },
  ]);
  const before = JSON.stringify(input);
  const output = formatCheckReport(input);
  assert.match(output, /result-refinement-unproven: 2 findings/);
  assert.doesNotMatch(output, /A result needs refinement/);
  assert.match(output, /queries.ts:3:10 \[unchecked\] dynamic-fragments/);
  assert.match(output, /queries.ts:3:10 \[mismatch\] result-type-mismatch/);
  assert.equal(JSON.stringify(input), before);
});
