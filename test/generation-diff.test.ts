import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definitionDiff } from '../src/generation/diff.js';

test('definition diff locates replacements and omits the common prefix and suffix', () => {
  assert.equal(
    definitionDiff('unchanged\nold\nend\n', 'unchanged\nnew\nend\n'),
    'Diff excerpt from line 2 (- saved, + generated):\n- old\n+ new',
  );
  assert.equal(definitionDiff('unchanged\n', 'unchanged\n'), '');
});

test('definition diff handles additions, removals, empty files, and final newlines', () => {
  assert.equal(
    definitionDiff('first\nlast\n', 'first\nadded\nlast\n'),
    'Diff excerpt from line 2 (- saved, + generated):\n+ added',
  );
  assert.equal(
    definitionDiff('first\nremoved\nlast\n', 'first\nlast\n'),
    'Diff excerpt from line 2 (- saved, + generated):\n- removed',
  );
  assert.equal(
    definitionDiff('', 'new\n'),
    'Diff excerpt from line 1 (- saved, + generated):\n+ new',
  );
  assert.equal(
    definitionDiff('old\n', ''),
    'Diff excerpt from line 1 (- saved, + generated):\n- old',
  );
  assert.equal(
    definitionDiff('same', 'same\n'),
    'Diff excerpt from line 2 (- saved, + generated):\n+ ',
  );
});

test('definition diff bounds both sides of large changes and truncates long lines', () => {
  const saved = Array.from({ length: 1000 }, (_, i) => `old ${i}`).join('\n');
  const generated = Array.from({ length: 1000 }, (_, i) => `new ${i}`).join('\n');
  const diff = definitionDiff(saved, generated);
  assert.ok(diff.includes('- old 0\n- old 1'));
  assert.ok(diff.includes('+ new 0\n+ new 1'));
  assert.equal(diff.split('\n').filter((line) => line.startsWith('- ')).length, 8);
  assert.equal(diff.split('\n').filter((line) => line.startsWith('+ ')).length, 8);
  assert.ok(diff.includes('992 more - lines omitted'));
  assert.ok(diff.includes('992 more + lines omitted'));

  const longLine = definitionDiff('x'.repeat(10000), 'y'.repeat(10000));
  assert.ok(longLine.includes(`- ${'x'.repeat(200)}…`));
  assert.ok(longLine.includes(`+ ${'y'.repeat(200)}…`));
  assert.ok(longLine.length < 500);
});
