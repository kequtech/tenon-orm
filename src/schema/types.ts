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
