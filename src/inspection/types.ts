import type { CodecRegistry, DescribeStatement } from '@kequtech/pgclear';
import type { ConnectionConfig } from '../connection.js';

export interface InspectionSession {
  readonly role?: string | undefined;
  /** PostgreSQL's search_path setting, as used in the application's connection options. */
  readonly searchPath?: string | undefined;
  readonly timeZone?: string | undefined;
}

export interface InspectionTimeouts {
  readonly connectMs?: number | undefined;
  readonly statementMs?: number | undefined;
  readonly lockMs?: number | undefined;
}

export interface InspectionContext {
  readonly mode: 'separate-session';
  readonly database: string;
  readonly sessionUser: string;
  readonly currentUser: string;
  readonly searchPath: string;
  readonly resolvedSearchPath: readonly string[];
  readonly timeZone: string;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly readMappings: 'pgclear';
}

export interface DescribeOptions {
  /** URI or pool configuration values. Inspection owns a separate, short-lived connection. */
  readonly connection: ConnectionConfig;
  /** Finished SQL; query values are neither bound nor executed. */
  readonly query: string | DescribeStatement;
  /** Use the same registry as execution; custom decoder types can remain unresolved. */
  readonly codecs?: CodecRegistry | undefined;
  readonly session?: InspectionSession | undefined;
  readonly timeouts?: InspectionTimeouts | undefined;
}

export type DescriptionIssue =
  | { readonly code: 'nullability-unknown'; readonly message: string }
  | {
      readonly code: 'shape-unknown';
      readonly message: string;
      readonly columns: readonly string[];
    }
  | {
      readonly code: 'unmapped-type';
      readonly message: string;
      readonly postgres: string;
      readonly oid: number;
    }
  | { readonly code: 'duplicate-column'; readonly message: string; readonly column: string };

export interface DescribedType {
  readonly oid: number;
  readonly postgres: string;
  /** pgclear read representation, before considering result nullability. */
  readonly readType: string;
}

export interface DescribedColumn extends DescribedType {
  readonly name: string;
  readonly nullability: 'unknown';
  /** Source constraint only: outer joins and grouping can still introduce NULL. */
  readonly source: {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
    readonly notNull: boolean;
  } | null;
}

export interface QueryDescription {
  readonly context: InspectionContext;
  readonly parameters: readonly DescribedType[];
  readonly columns: readonly DescribedColumn[];
  /** Conservative result declaration. This does not verify an existing annotation. */
  readonly rowType: string | null;
  readonly issues: readonly DescriptionIssue[];
}
