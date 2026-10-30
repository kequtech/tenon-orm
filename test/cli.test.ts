import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPool } from '@kequtech/pgclear';
import { recordMigrations } from './fixtures/record-migrations.js';
import {
  assertTestDatabase,
  testConnection as connection,
  migrationProject,
} from './helpers/database.js';
const pool = createPool({ connectionString: connection });
const project = migrationProject(pool);
before(() => assertTestDatabase(pool));
after(() => pool.close());
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('generation, checking and inspection require configuration even when DATABASE_URL is set', async () => {
  await project({}, async (options) => {
    for (const command of [
      ['generate', '--out', 'schema.ts'],
      ['check'],
      ['describe', 'query.sql'],
    ]) {
      await assert.rejects(
        run(process.execPath, [cli, ...command], {
          cwd: options.directory,
          env: { ...process.env, DATABASE_URL: connection },
        }),
        (error) => {
          assert.ok(error instanceof Error && 'stderr' in error);
          assert.match(String(error.stderr), /configuration is required/);
          return true;
        },
      );
    }
    await assert.rejects(readFile(join(options.directory, 'schema.ts')), { code: 'ENOENT' });
  });
});

test('flags for other commands reject before changing files or the database', async () => {
  await project(recordMigrations, async (options) => {
    const env = { ...process.env, DATABASE_URL: connection };
    const common = ['--directory', options.directory, '--namespace', options.namespace];
    for (const args of [
      ['migrate', '--check'],
      ['migrate', '--steps', '2'],
      ['migrate', '--role', 'ignored-role'],
      ['status', '--statement-timeout-ms', '100'],
      ['status', '--out', join(options.directory, 'unexpected.ts')],
      ['baseline', 'adopt', '--schema', 'public'],
      ['new', 'unexpected', '--check'],
    ]) {
      await assert.rejects(run(process.execPath, [cli, ...args, ...common], { env }));
    }
    const rows = (
      await pool.queryClassic('SELECT 1 FROM pg_namespace WHERE nspname = $1', [options.namespace])
    ).rows;
    assert.deepEqual([...rows], []);
    await assert.rejects(readFile(join(options.directory, '0002_unexpected.up.sql')), {
      code: 'ENOENT',
    });
  });
});
