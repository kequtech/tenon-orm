import { defaultCodecs } from '@kequtech/pgclear';
import { compareContracts } from './check/contracts.js';
import { librarySymbols, loadProject, location } from './check/project.js';
import { SourceAnalysis } from './check/source.js';
import type { CheckDiagnostic, CheckedQuery, CheckOptions, CheckReport } from './check/types.js';
import { readStatementMetadata } from './inspection/catalog.js';
import { withInspectionConnection } from './inspection/connection.js';
import { queryDescription } from './inspection/result.js';
import { plainObject } from './validation.js';
import type { InspectionContext } from './inspection/types.js';

export type {
  CheckOptions,
  CheckReport,
  CheckDiagnostic,
  CheckedQuery,
  SourceLocation,
} from './check/types.js';

function distinct(diagnostics: readonly CheckDiagnostic[]): CheckDiagnostic[] {
  return [
    ...new Map(diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic])).values(),
  ];
}

/** Analyse authored source without importing the application, binding values or executing its SQL. */
export async function checkQueries(options: CheckOptions): Promise<CheckReport> {
  for (const name of Object.keys(plainObject(options, 'Check options'))) {
    if (
      !['connection', 'target', 'project', 'session', 'timeouts', 'codecs', 'readTypes'].includes(
        name,
      )
    )
      throw new Error(`Unknown check option: ${name}`);
  }
  const project = loadProject(options);
  const libraries = librarySymbols(project);
  const diagnostics = [...project.diagnostics];
  const queries = project.selected.flatMap((source) =>
    new SourceAnalysis(project, libraries).discover(source),
  );
  const selected =
    project.line === undefined
      ? queries
      : queries.filter((query) => {
          const source = query.getSourceFile();
          const start = source.getLineAndCharacterOfPosition(query.getStart(source)).line + 1;
          const end = source.getLineAndCharacterOfPosition(query.end).line + 1;
          // Include a variable declaration's first line when the template starts on its next line.
          const declarationStart =
            query.parent.getSourceFile() === source
              ? source.getLineAndCharacterOfPosition(query.parent.getStart(source)).line + 1
              : start;
          return project.line! >= Math.min(start, declarationStart) && project.line! <= end;
        });
  if (!selected.length || (project.line !== undefined && selected.length > 1)) {
    diagnostics.push({
      file: project.selected[0]?.fileName ?? project.project,
      line: project.line ?? 1,
      column: 1,
      kind: 'unchecked',
      code: selected.length ? 'ambiguous-query-target' : 'no-query-sites',
      message: selected.length
        ? 'Several queries occupy this line. Put their SQL tags on distinct lines.'
        : 'No recognized complete Tenon query was found at the selected target.',
    });
    return { project: project.project, ok: false, queries: [], diagnostics };
  }
  const recovered = selected.map((query) => {
    const analysis = new SourceAnalysis(project, libraries);
    const variants = analysis.recover(query);
    return { query, variants, diagnostics: analysis.issues };
  });
  const reports: CheckedQuery[] = [];
  const codecs = options.codecs ?? defaultCodecs;
  const readTypes = { ...options.readTypes };
  for (const oid of Object.keys(readTypes)) {
    if (codecs.typescript(Number(oid)) !== undefined)
      throw new Error(
        `readTypes may only supply an unresolved custom decoder representation (OID ${oid} already has a known representation).`,
      );
  }
  const finish = (): CheckReport => {
    const all = distinct([...diagnostics, ...reports.flatMap((report) => report.diagnostics)]);
    return {
      project: project.project,
      ok: reports.length > 0 && !all.some((diagnostic) => diagnostic.kind !== 'unproven'),
      queries: reports,
      diagnostics: all,
    };
  };
  if (!recovered.some(({ variants }) => variants.length)) {
    for (const entry of recovered)
      reports.push({
        ...location(entry.query),
        status: 'unchecked',
        variants: 0,
        diagnostics: distinct(entry.diagnostics),
      });
    return finish();
  }
  let context: InspectionContext | undefined;
  try {
    context = await withInspectionConnection(options, async (session, context) => {
      for (const entry of recovered) {
        const findings = [...entry.diagnostics];
        let described = 0;
        for (const [index, variant] of entry.variants.entries()) {
          try {
            const metadata = await readStatementMetadata(session, {
              text: variant.text,
              parameterTypes: variant.parameterTypes,
            });
            const description = queryDescription(metadata, context, codecs);
            described++;
            findings.push(
              ...compareContracts(project, entry.query, variant, description, readTypes).map(
                (diagnostic) =>
                  variant.uncertainParameters.length && diagnostic.kind === 'mismatch'
                    ? {
                        ...diagnostic,
                        kind: 'unproven' as const,
                        code: 'encoder-dependent-result-unproven',
                        variant: index + 1,
                        message: `${diagnostic.message} The actual encoder OID is unknown, so this inferred result cannot contradict the declared type.`,
                      }
                    : { ...diagnostic, variant: index + 1 },
              ),
            );
          } catch (error) {
            const code =
              error && typeof error === 'object' && 'code' in error ? error.code : undefined;
            const sqlError = typeof code === 'string' && code.startsWith('42') && code !== '42501';
            const uncertain =
              sqlError &&
              variant.uncertainParameters.length > 0 &&
              !['42601', '42P01'].includes(String(code));
            findings.push({
              ...location(entry.query),
              kind: uncertain ? 'unproven' : sqlError ? 'mismatch' : 'unchecked',
              code: typeof code === 'string' ? code : 'describe-failed',
              variant: index + 1,
              message: `${error instanceof Error ? error.message : 'Describe failed.'}${uncertain ? ' The actual encoder OID is unknown; this inference failure does not disprove the declared contract.' : ''}`,
            });
          }
        }
        reports.push({
          ...location(entry.query),
          status: findings.some((finding) => finding.kind === 'unchecked')
            ? 'unchecked'
            : 'analysed',
          variants: described,
          diagnostics: distinct(findings),
        });
      }
      return context;
    });
  } catch (error) {
    for (const entry of recovered.slice(reports.length))
      reports.push({
        ...location(entry.query),
        status: 'unchecked',
        variants: 0,
        diagnostics: entry.diagnostics,
      });
    diagnostics.push({
      ...location(selected[0]!),
      kind: 'unchecked',
      code: 'inspection-failed',
      message: error instanceof Error ? error.message : 'Inspection connection failed.',
    });
  }
  return { ...finish(), ...(context ? { context } : {}) };
}
