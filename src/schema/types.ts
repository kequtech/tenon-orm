import type { DatabaseToolOptions } from '../migrations/connection.js';

export type SchemaOptions = Pick<DatabaseToolOptions, 'connection' | 'namespace'>;

export interface SchemaDefinition {
  readonly name: string;
  readonly definition: string;
}

export interface SchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  /** Default or generated expression, distinguished by generated. */
  readonly expression: string | null;
  readonly identity: '' | 'a' | 'd';
  readonly generated: '' | 's' | 'v';
  readonly collation: string | null;
}

export interface SchemaTable {
  readonly name: string;
  readonly kind: 'r' | 'p';
  readonly persistence: 'p' | 'u' | 't';
  readonly parents: readonly string[];
  readonly partitionKey: string | null;
  readonly partitionBound: string | null;
  readonly columns: readonly SchemaColumn[];
  readonly constraints: readonly SchemaDefinition[];
  readonly indexes: readonly (SchemaDefinition & {
    readonly valid: boolean;
    readonly ready: boolean;
  })[];
}

export interface SchemaEnum {
  readonly name: string;
  readonly labels: readonly string[];
}

export interface SchemaDomain {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly collation: string | null;
  readonly constraints: readonly SchemaDefinition[];
}

export interface SchemaSequence {
  readonly name: string;
  readonly type: string;
  readonly start: string;
  readonly increment: string;
  readonly min: string;
  readonly max: string;
  readonly cache: string;
  readonly cycle: boolean;
  readonly ownedBy: {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
  } | null;
}

/** Version 1 covers declared relation/type metadata, not data, functions or security policy. */
export interface SchemaMetadata {
  readonly formatVersion: 1;
  readonly postgresMajor: number;
  readonly namespace: string;
  readonly tables: readonly SchemaTable[];
  readonly enums: readonly SchemaEnum[];
  readonly domains: readonly SchemaDomain[];
  readonly sequences: readonly SchemaSequence[];
}

export interface SchemaSnapshot extends SchemaMetadata {
  readonly fingerprint: string;
}

export type SchemaValue =
  | null
  | boolean
  | number
  | string
  | readonly SchemaValue[]
  | { readonly [key: string]: SchemaValue };

export interface SchemaDifference {
  readonly kind: 'added' | 'removed' | 'changed';
  /** Collection/object names identify objects; numeric positions identify ordered values. */
  readonly path: readonly (string | number)[];
  readonly expected?: SchemaValue;
  readonly actual?: SchemaValue;
}

export interface SchemaAcceptedDifference extends SchemaDifference {
  readonly reason: 'postgres-major' | 'check-text-array-casts';
}

export interface SchemaComparisonOptions {
  /** Defaults to false; a version change still requires separate compatibility review. */
  readonly ignorePostgresMajor?: boolean;
  /** Defaults to false. Recognize only text ANY arrays of unconstrained varchar literals. */
  readonly normalizeCheckTextArrayCasts?: boolean;
}

export interface SchemaComparison {
  readonly equivalent: boolean;
  readonly differences: readonly SchemaDifference[];
  /** Explicitly accepted raw differences remain available for review/logging. */
  readonly acceptedDifferences: readonly SchemaAcceptedDifference[];
}
