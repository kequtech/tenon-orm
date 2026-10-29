import type { DescribeOptions, InspectionContext } from '../inspection/types.js';

export interface CheckOptions extends Pick<
  DescribeOptions,
  'connection' | 'session' | 'timeouts' | 'codecs'
> {
  /** File, file:line (one-based), or omission for the project's source files. */
  readonly target?: string;
  /** tsconfig path; otherwise discover it from the target file or working directory. */
  readonly project?: string;
  /** Explicit custom decoder representations, as TypeScript type expressions. */
  readonly readTypes?: Readonly<Record<number, string>>;
}

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface CheckDiagnostic extends SourceLocation {
  readonly kind: 'mismatch' | 'unchecked' | 'unproven';
  readonly code: string;
  readonly message: string;
  readonly parameter?: number;
  readonly resultColumn?: string;
  readonly expected?: string;
  readonly observed?: string;
  readonly variant?: number;
}

export interface CheckedQuery extends SourceLocation {
  readonly status: 'analysed' | 'unchecked';
  readonly variants: number;
  readonly diagnostics: readonly CheckDiagnostic[];
}

export interface CheckReport {
  readonly project: string;
  readonly ok: boolean;
  readonly queries: readonly CheckedQuery[];
  readonly diagnostics: readonly CheckDiagnostic[];
  readonly context?: InspectionContext;
}
