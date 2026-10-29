import {
  generateDefinitions as generateDriverDefinitions,
  type GenerateOptions as DriverGenerateOptions,
} from '@kequtech/pgclear';
import type { Connection } from './connection.js';
import { withMigrationLock } from './migrations/connection.js';
import { migrationTable } from './migrations/history.js';

export interface GenerateOptions {
  readonly connection: Connection;
  readonly namespace?: string;
  readonly onWarning?: DriverGenerateOptions['onWarning'];
}

/** Tenon owns migration coordination and output checking; pgclear owns the generated types. */
export function generateDefinitions(options: GenerateOptions): Promise<string> {
  return withMigrationLock(options, 'shared', (client, namespace) =>
    generateDriverDefinitions({
      connection: client,
      namespace,
      excludeTables: [migrationTable],
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    }),
  );
}
