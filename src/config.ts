import type { ConnectionConfig } from './connection.js';
import type { InspectionSession, InspectionTimeouts } from './inspection/types.js';

/** Shared runtime connection values and CLI defaults. Export without opening a database. */
export interface TenonConfig {
  readonly connection: ConnectionConfig;
  readonly generate?: {
    readonly out: string;
    readonly namespace?: string;
  };
  readonly migrations?: {
    readonly directory?: string;
    readonly namespace?: string;
  };
  /** Native pg_dump connection/scope; defaults to the main connection only when it is a string. */
  readonly baseline?: {
    readonly connection?: string;
    readonly schemas?: readonly string[];
  };
  readonly check?: {
    readonly project?: string;
    readonly readTypes?: Readonly<Record<number, string>>;
  };
  readonly session?: InspectionSession;
  readonly timeouts?: InspectionTimeouts;
}
