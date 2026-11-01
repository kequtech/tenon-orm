import { createHash } from 'node:crypto';
import { defaultCodecs } from '@kequtech/pgclear';
import type { CatalogClient } from './generation/catalog.js';
import { withMigrationLock } from './migrations/connection.js';
import { quote } from './sql.js';
import { plainObject } from './validation.js';
import { readSchema } from './schema/catalog.js';
import type { SchemaOptions, SchemaSnapshot } from './schema/types.js';

export type {
  SchemaOptions,
  SchemaMetadata,
  SchemaSnapshot,
  SchemaTable,
  SchemaColumn,
  SchemaEnum,
  SchemaDomain,
  SchemaSequence,
  SchemaDefinition,
} from './schema/types.js';

/** Canonical JSON: object keys are sorted; ordered catalog arrays retain their semantic order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(object[key]))
        .join(',') +
      '}'
    );
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Schema metadata is not JSON serializable.');
  return json;
}

/** Read a versioned, codec-independent catalog snapshot without executing application SQL. */
export async function inspectSchema(options: SchemaOptions): Promise<SchemaSnapshot> {
  for (const name of Object.keys(plainObject(options, 'Schema options')))
    if (!['connection', 'namespace'].includes(name))
      throw new Error(`Unknown schema option: ${name}`);
  return withMigrationLock(options, 'shared', (client, namespace) =>
    client.transaction(
      async (transaction) => {
        const catalog: CatalogClient = {
          query: (text, values = []) =>
            transaction.queryClassic(text, values, { codecs: defaultCodecs }),
        };
        const exists = await catalog.query(
          'SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1',
          [namespace],
        );
        if (!exists.rows.length) throw new Error(`Schema ${quote(namespace)} does not exist.`);
        await catalog.query(`SELECT pg_catalog.set_config(name, value, true) FROM (VALUES
          ('search_path', 'pg_catalog'), ('quote_all_identifiers', 'on'),
          ('standard_conforming_strings', 'on'), ('TimeZone', 'UTC'),
          ('DateStyle', 'ISO, YMD'), ('IntervalStyle', 'postgres'),
          ('bytea_output', 'hex'), ('extra_float_digits', '3'), ('lc_monetary', 'C')
        ) AS settings(name, value)`);
        const metadata = await readSchema(catalog, namespace);
        const hash = createHash('sha256').update(canonical(metadata)).digest('hex');
        return { ...metadata, fingerprint: `tenon-schema-v1:sha256:${hash}` };
      },
      { isolation: 'repeatable read', readOnly: true },
    ),
  );
}
