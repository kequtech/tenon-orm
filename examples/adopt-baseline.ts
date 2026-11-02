// Copy outside node_modules in an ESM app. Run once at the reviewed legacy checkpoint.
// Stop the old runner and freeze DDL first. Separately verify functions, grants, RLS and old history;
// the catalog fingerprint below does not cover those application-specific contracts.
import { readFile } from 'node:fs/promises';
import { adoptBaseline, inspectSchema, migrate } from '@kequtech/tenon-orm';

const [checkpointPath, directory = 'migrations', ...extra] = process.argv.slice(2);
if (!checkpointPath || extra.length)
  throw new Error('Usage: node adopt-baseline.ts <frozen-checkpoint.json> [migration-directory]');
const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required.');
const expected: unknown = JSON.parse(await readFile(checkpointPath, 'utf8'));
if (
  typeof expected !== 'object' ||
  expected === null ||
  !('formatVersion' in expected) ||
  expected.formatVersion !== 1 ||
  !('namespace' in expected) ||
  typeof expected.namespace !== 'string' ||
  !('fingerprint' in expected) ||
  typeof expected.fingerprint !== 'string' ||
  !/^tenon-schema-v1:sha256:[a-f0-9]{64}$/.test(expected.fingerprint)
)
  throw new Error('Expected a frozen version-1 tenon schema checkpoint from a trusted replay.');

const options = { connection, namespace: expected.namespace, directory };
const observed = await inspectSchema({ connection, namespace: expected.namespace });
if (observed.fingerprint !== expected.fingerprint)
  throw new Error('Schema differs from the reviewed checkpoint. Baseline was not adopted.');
await adoptBaseline(options);
await migrate(options);
