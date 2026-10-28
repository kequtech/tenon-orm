export type { JSONValue } from 'postgres';
export type { Connection, ConnectionOptions, ConnectionUri, QueryResult } from './connection.js';
export type { AffectedRowsConstraint } from './affected-rows.js';
export { createTenon } from './database.js';
export type { TenonOptions } from './database.js';
export { AffectedRowsError } from './errors.js';
export type { QueryOptions, QueryOutput, QueryReturnMode } from './query-options.js';
export { identifier, sql, unsafeSql } from './query.js';
export type { SqlFragment, SqlQuery, UnknownRow } from './query.js';
export type { Database, QueryClient, QueryEvent, Transaction } from './types.js';

export { describeQuery } from './describe.js';
export type {
  DescribeOptions,
  DescribedColumn,
  DescribedType,
  DescriptionIssue,
  InspectionContext,
  InspectionSession,
  InspectionTimeouts,
  QueryDescription,
} from './inspection/types.js';

export { adoptBaseline, captureBaseline } from './baseline.js';
export type { CaptureBaselineOptions, CapturedBaseline } from './baseline.js';
export { generateDefinitions } from './generate.js';
export type { GenerateOptions } from './generate.js';
export { migrate, migrationStatus, rollback } from './migrations.js';
export type { MigrationStatus } from './migrations.js';
export type { DatabaseToolOptions } from './migrations/connection.js';
export { createMigration, readMigrations } from './migrations/files.js';
export type { CreateMigrationOptions, CreatedMigration, SqlMigration } from './migrations/files.js';
