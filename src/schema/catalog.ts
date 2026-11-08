import type { CatalogClient } from '../generation/catalog.js';
import { migrationTable } from '../migrations/history.js';
import type { SchemaMetadata } from './types.js';

/** Transaction-local formatting shared by public snapshots and baseline checkpoints. */
export async function configureSchemaCatalog(client: CatalogClient): Promise<void> {
  await client.query(`SELECT pg_catalog.set_config(name, value, true) FROM (VALUES
    ('search_path', 'pg_catalog'), ('quote_all_identifiers', 'on'),
    ('standard_conforming_strings', 'on'), ('TimeZone', 'UTC'),
    ('DateStyle', 'ISO, YMD'), ('IntervalStyle', 'postgres'),
    ('bytea_output', 'hex'), ('extra_float_digits', '3'), ('lc_monetary', 'C')
  ) AS settings(name, value)`);
}

/** Versioned catalog contract: change formatVersion when changing fingerprint inputs. */
export async function readSchema(
  client: CatalogClient,
  namespace: string,
): Promise<SchemaMetadata> {
  const result = await client.query<Omit<SchemaMetadata, 'formatVersion' | 'namespace'>>(
    `SELECT (pg_catalog.current_setting('server_version_num')::integer / 10000) AS "postgresMajor",
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', c.relname, 'kind', c.relkind, 'persistence', c.relpersistence,
        'parents', COALESCE((SELECT jsonb_agg(i.inhparent::regclass::text ORDER BY i.inhseqno)
          FROM pg_inherits i WHERE i.inhrelid = c.oid), '[]'::jsonb),
        'partitionKey', pg_get_partkeydef(c.oid),
        'partitionBound', pg_get_expr(c.relpartbound, c.oid, false),
        'columns', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
          'nullable', NOT a.attnotnull, 'expression', pg_get_expr(d.adbin, d.adrelid, false),
          'identity', a.attidentity, 'generated', a.attgenerated,
          'collation', CASE WHEN a.attcollation <> t.typcollation THEN a.attcollation::regcollation::text END
        ) ORDER BY a.attnum)
          FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::jsonb),
        'constraints', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'name', x.conname, 'definition', pg_get_constraintdef(x.oid, false)
        ) ORDER BY x.conname COLLATE "C") FROM pg_constraint x
          WHERE x.conrelid = c.oid AND x.contype IN ('p','u','f','c','x')), '[]'::jsonb),
        'indexes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'name', ic.relname, 'definition', pg_get_indexdef(i.indexrelid, 0, false),
          'valid', i.indisvalid, 'ready', i.indisready
        ) ORDER BY ic.relname COLLATE "C") FROM pg_index i
          JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = c.oid), '[]'::jsonb)
      ) ORDER BY c.relname COLLATE "C")
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND c.relname <> $2
    ), '[]'::jsonb) AS tables,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', t.typname, 'labels',
        COALESCE((SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
          FROM pg_enum e WHERE e.enumtypid = t.oid), '[]'::jsonb)
      ) ORDER BY t.typname COLLATE "C") FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typtype = 'e'
    ), '[]'::jsonb) AS enums,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', t.typname, 'type', format_type(t.typbasetype, t.typtypmod),
        'nullable', NOT t.typnotnull, 'default', pg_get_expr(t.typdefaultbin, 0, false),
        'collation', CASE WHEN t.typcollation <> b.typcollation THEN t.typcollation::regcollation::text END,
        'constraints', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'name', x.conname, 'definition', pg_get_constraintdef(x.oid, false)
        ) ORDER BY x.conname COLLATE "C") FROM pg_constraint x WHERE x.contypid = t.oid), '[]'::jsonb)
      ) ORDER BY t.typname COLLATE "C") FROM pg_type t
      JOIN pg_type b ON b.oid = t.typbasetype JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typtype = 'd'
    ), '[]'::jsonb) AS domains,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', c.relname, 'type', s.seqtypid::regtype::text,
        'start', s.seqstart::text, 'increment', s.seqincrement::text,
        'min', s.seqmin::text, 'max', s.seqmax::text, 'cache', s.seqcache::text, 'cycle', s.seqcycle,
        'ownedBy', (SELECT jsonb_build_object('schema', rn.nspname, 'table', r.relname, 'column', a.attname)
          FROM pg_depend d JOIN pg_class r ON r.oid = d.refobjid
          JOIN pg_namespace rn ON rn.oid = r.relnamespace
          JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = d.refobjsubid
          WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
            AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a','i'))
      ) ORDER BY c.relname COLLATE "C") FROM pg_sequence s
      JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
    ), '[]'::jsonb) AS sequences`,
    [namespace, migrationTable],
  );
  return { formatVersion: 1, namespace, ...result.rows[0]! };
}
