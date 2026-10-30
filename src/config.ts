import type { Pool } from '@kequtech/pgclear';
import type { ConnectionConfig } from './connection.js';
import type { QueryEvent } from './types.js';
import type { InspectionSession, InspectionTimeouts } from './inspection/types.js';

/** Shared runtime connection values and CLI defaults. Export without opening a database. */
export interface TenonConfig {
  /** Environment values may be absent during builds; database use validates them. */
  readonly connection: ConnectionConfig | Pool | undefined;
  /** Observe runtime queries; native driver calls and CLI tooling do not invoke this callback. */
  readonly onQuery?: (event: QueryEvent) => void | Promise<void>;
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
    readonly connection?: string | undefined;
    readonly schemas?: readonly string[];
  };
  readonly check?: {
    readonly project?: string;
    readonly readTypes?: Readonly<Record<number, string>>;
  };
  readonly session?: InspectionSession;
  readonly timeouts?: InspectionTimeouts;
}
