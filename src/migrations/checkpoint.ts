import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultCodecs, type Session } from '@kequtech/pgclear';
import type { CatalogClient } from '../generation/catalog.js';
import { canonical } from '../schema.js';
import { configureSchemaCatalog, readSchema } from '../schema/catalog.js';
import { compareSchemas } from '../schema/compare.js';
import type { SchemaMetadata } from '../schema/types.js';
import { validateName } from '../sql.js';
import { baselineHeader, checkpointFilename } from './baseline-sql.js';
import type { SqlMigration } from './files.js';
import { migrationTable } from './history.js';

export { checkpointFilename } from './baseline-sql.js';
interface BaselineSchema extends SchemaMetadata {
  readonly objects: readonly { kind: string; name: string; definition: string | null }[];
}
export interface BaselineCheckpoint {
  readonly formatVersion: 1;
  readonly namespace: string;
  readonly migrationChecksum: string;
  readonly schemas: readonly BaselineSchema[];
}

export function checkpointHash(checkpoint: BaselineCheckpoint): string {
  return createHash('sha256').update(canonical(checkpoint)).digest('hex');
}

export function isCapturedBaseline(file: SqlMigration): boolean {
  return file.id === '0001' && file.name === 'baseline' && file.up.startsWith(baselineHeader);
}

export async function readCheckpoint(
  directory: string,
  namespace: string,
  baseline: SqlMigration,
): Promise<BaselineCheckpoint> {
  const path = join(directory, checkpointFilename);
  let saved: unknown;
  try {
    saved = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(
      `Missing or unreadable baseline checkpoint: ${path}. Capture and commit the baseline SQL and checkpoint together before the first migrate.`,
    );
  }
  if (!saved || typeof saved !== 'object') throw new Error(`Invalid baseline checkpoint: ${path}.`);
  const { fingerprint, ...checkpoint } = saved as BaselineCheckpoint & { fingerprint: unknown };
  if (
    checkpoint.formatVersion !== 1 ||
    checkpoint.namespace !== namespace ||
    baseline.down !== undefined ||
    checkpoint.migrationChecksum !== baseline.checksum ||
    !Array.isArray(checkpoint.schemas) ||
    !checkpoint.schemas.length ||
    fingerprint !== checkpointHash(checkpoint)
  )
    throw new Error(
      `Baseline checkpoint does not match its SQL, namespace or format: ${path}. Restore the captured pair; do not derive a replacement from the deployment target.`,
    );
  const names = new Set<string>();
  for (const schema of checkpoint.schemas) {
    if (!schema || typeof schema !== 'object')
      throw new Error(`Invalid baseline checkpoint: ${path}.`);
    validateName(schema.namespace);
    if (names.has(schema.namespace) || !Array.isArray(schema.objects))
      throw new Error(`Invalid baseline checkpoint schema: ${path}.`);
    names.add(schema.namespace);
    compareSchemas(schema, schema);
  }
  return checkpoint;
}

export function checkpointCatalog(client: Pick<Session, 'queryClassic'>): CatalogClient {
  return {
    query: (text, values = []) => client.queryClassic(text, values, { codecs: defaultCodecs }),
  };
}

/** Same snapshot/settings as the dump. Include excluded legacy objects in the adoption contract. */
export async function readBaselineSchemas(
  client: CatalogClient,
  namespaces: readonly string[],
): Promise<readonly BaselineSchema[]> {
  await configureSchemaCatalog(client);
  const schemas: BaselineSchema[] = [];
  for (const namespace of namespaces) {
    const metadata = await readSchema(client, namespace);
    const objects = await client.query<BaselineSchema['objects'][number]>(
      `
      SELECT kind, name, definition FROM (
        SELECT 'relation' AS kind, c.relname::text AS name,
          CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, false) END AS definition
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname <> $2
          AND NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
            WHERE i.indexrelid = c.oid AND t.relname = $2)
        UNION ALL
        SELECT 'function', p.oid::regprocedure::text,
          CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) END
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1
        UNION ALL
        SELECT 'type', t.typname::text, NULL::text
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1 AND NOT EXISTS (
          SELECT 1 FROM pg_type e JOIN pg_class c ON c.oid = e.typrelid
          WHERE c.relname = $2 AND (t.oid = e.oid OR t.typelem = e.oid))
        UNION ALL
        SELECT 'trigger', format('%I.%I', c.relname, t.tgname), pg_get_triggerdef(t.oid, false)
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND NOT t.tgisinternal AND c.relname <> $2
        UNION ALL
        SELECT 'rule', format('%I.%I', c.relname, r.rulename), pg_get_ruledef(r.oid, false)
        FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
          JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname <> $2
      ) objects ORDER BY kind COLLATE "C", name COLLATE "C"`,
      [namespace, migrationTable],
    );
    schemas.push({ ...metadata, objects: objects.rows });
  }
  return schemas;
}

/** Run inside the first migration transaction and exclusive advisory lock, before any DDL. */
export async function baselineDisposition(
  client: Session,
  checkpoint: BaselineCheckpoint,
): Promise<'fresh' | 'matching'> {
  const observed = await readBaselineSchemas(
    checkpointCatalog(client),
    checkpoint.schemas.map((s) => s.namespace),
  );
  if (observed.every((schema) => !schema.objects.length)) return 'fresh';
  const differences = checkpoint.schemas.flatMap((expected, i) =>
    compareSchemas(expected, observed[i]!, { normalizeCheckTextArrayCasts: true }).differences.map(
      (difference) => ({
        ...difference,
        path: ['schemas', expected.namespace, ...difference.path],
      }),
    ),
  );
  if (differences.length)
    throw new Error(
      `Schema differs from the captured baseline checkpoint. No baseline was adopted or executed.\n${JSON.stringify(differences, null, 2)}`,
    );
  return 'matching';
}
