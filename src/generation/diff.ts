/** A bounded text excerpt, not a schema comparison or an applicable patch. */
export function definitionDiff(saved: string, generated: string): string {
  const before = saved.split('\n');
  const after = generated.split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start++;
  }
  if (start === before.length && start === after.length) return '';

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }

  function excerpt(lines: readonly string[], end: number, marker: '-' | '+'): string[] {
    const shown = lines.slice(start, Math.min(end, start + 8));
    const output = shown.map(
      (line) => `${marker} ${line.length > 200 ? line.slice(0, 200) + '…' : line}`,
    );
    if (end - start > shown.length) {
      output.push(`  … ${end - start - shown.length} more ${marker} lines omitted`);
    }
    return output;
  }

  return [
    `Diff excerpt from line ${start + 1} (- saved, + generated):`,
    ...excerpt(before, beforeEnd, '-'),
    ...excerpt(after, afterEnd, '+'),
  ].join('\n');
}
