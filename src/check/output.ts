import type { CheckDiagnostic, CheckReport } from './types.js';

function group(diagnostics: readonly CheckDiagnostic[]) {
  const groups = new Map<string, { diagnostic: CheckDiagnostic; variants: Set<number> }>();
  for (const diagnostic of diagnostics) {
    const { variant, ...finding } = diagnostic;
    const key = JSON.stringify(finding);
    let entry = groups.get(key);
    if (!entry) {
      entry = { diagnostic, variants: new Set() };
      groups.set(key, entry);
    }
    if (variant !== undefined) entry.variants.add(variant);
  }
  return [...groups.values()];
}

/** Group presentation only; JSON retains each finding's SQL variant. */
export function formatCheckReport(report: CheckReport): string {
  const queryFindings = new Set(report.queries.flatMap((query) => query.diagnostics));
  const findings = [
    ...group(report.diagnostics.filter((finding) => !queryFindings.has(finding))),
    ...report.queries.flatMap((query) => group(query.diagnostics)),
  ];
  const lines = findings.map(({ diagnostic: d, variants }) => {
    const scope = variants.size
      ? ` [variant${variants.size === 1 ? '' : 's'} ${[...variants].join(', ')}]`
      : '';
    return `${d.file}:${d.line}:${d.column} [${d.kind}] ${d.code}${scope}: ${d.message}`;
  });
  lines.push(
    `${report.coverage.total} queries, ${report.coverage.analysed} analysed, ${report.coverage.unchecked} unchecked; ${findings.filter(({ diagnostic }) => diagnostic.kind === 'mismatch').length} definite mismatches, ${findings.filter(({ diagnostic }) => diagnostic.kind === 'unproven').length} unproven findings.`,
    'Checks exclude result nullability and runtime value validation.',
  );
  return lines.join('\n') + '\n';
}
