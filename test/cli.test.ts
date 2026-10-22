import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { qualified } from '../src/sql.js';
import { recordMigrations } from './fixtures/record-migrations.js';
import {
  assertTestDatabase,
  testConnection as connection,
  migrationProject,
} from './helpers/database.js';
const pool = new Pool({ connectionString: connection });
const project = migrationProject(pool);
before(() => assertTestDatabase(pool));
after(() => pool.end());
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('CLI migration and generation remain separate; check mode catches stale files without rewriting', async () => {
  await project(recordMigrations, async (options) => {
    const output = join(options.directory, 'definitions.ts');
    const args = ['--directory', options.directory, '--namespace', options.namespace];
    const env = { ...process.env, DATABASE_URL: connection };
    await run(process.execPath, [cli, 'migrate', ...args], { env });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    await run(process.execPath, [cli, 'generate', ...args, '--out', output], { env });
    const first = await readFile(output, 'utf8');
    await run(process.execPath, [cli, 'generate', ...args, '--out', output, '--check'], { env });
    await pool.query(
      `ALTER TABLE ${qualified(options.namespace, 'Record')} ALTER COLUMN name SET DEFAULT 'draft'`,
    );
    await assert.rejects(
      run(process.execPath, [cli, 'generate', ...args, '--out', output, '--check'], { env }),
    );
    assert.equal(await readFile(output, 'utf8'), first);
    await run(process.execPath, [cli, 'generate', ...args, '--out', output], { env });
    assert.notEqual(await readFile(output, 'utf8'), first);
    await pool.query(
      `ALTER TABLE ${qualified(options.namespace, 'Record')} ALTER COLUMN name DROP DEFAULT`,
    );
    await run(process.execPath, [cli, 'generate', ...args, '--out', output], { env });
    assert.equal(await readFile(output, 'utf8'), first);
    await writeFile(
      join(options.directory, '0002_column.up.sql'),
      'ALTER TABLE "Record" ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT false;',
    );
    const pending = await run(process.execPath, [cli, 'generate', ...args, '--out', output], {
      env,
    });
    assert.ok(pending.stderr.trim());
    assert.equal(await readFile(output, 'utf8'), first);
    await run(process.execPath, [cli, 'migrate', ...args], { env });
    await assert.rejects(
      run(process.execPath, [cli, 'generate', ...args, '--out', output, '--check'], { env }),
    );
    assert.equal(await readFile(output, 'utf8'), first);
    await run(process.execPath, [cli, 'generate', ...args, '--out', output], { env });
    assert.notEqual(await readFile(output, 'utf8'), first);
    await writeFile(
      join(options.directory, '0003_unsupported.up.sql'),
      'ALTER TABLE "Record" ADD COLUMN amount INTERVAL;',
    );
    await run(process.execPath, [cli, 'migrate', ...args], { env });
    const unsupported = await run(process.execPath, [cli, 'generate', ...args, '--out', output], {
      env,
    });
    assert.ok(unsupported.stderr.includes('"Record"."amount"'));
    assert.ok(unsupported.stderr.includes('"pg_catalog"."interval"'));
    const withUnknown = await readFile(output, 'utf8');
    const current = await run(
      process.execPath,
      [cli, 'generate', ...args, '--out', output, '--check'],
      { env },
    );
    assert.ok(current.stderr.trim());
    assert.equal(await readFile(output, 'utf8'), withUnknown);
    await writeFile(
      join(options.directory, '0004_partition.up.sql'),
      'CREATE TABLE "Partitioned" (id INTEGER) PARTITION BY RANGE (id);',
    );
    await run(process.execPath, [cli, 'migrate', ...args], { env });
    await run(process.execPath, [cli, 'generate', ...args, '--out', output], { env });
    const withPartition = await readFile(output, 'utf8');
    await run(process.execPath, [cli, 'generate', ...args, '--out', output, '--check'], { env });
    await pool.query(`CREATE TABLE ${qualified(options.namespace, 'PartitionedDaily')}
      PARTITION OF ${qualified(options.namespace, 'Partitioned')} DEFAULT`);
    await run(process.execPath, [cli, 'generate', ...args, '--out', output, '--check'], { env });
    await pool.query(`DROP TABLE ${qualified(options.namespace, 'PartitionedDaily')}`);
    await run(process.execPath, [cli, 'generate', ...args, '--out', output, '--check'], { env });
    assert.equal(await readFile(output, 'utf8'), withPartition);
    // Other generation failures still preserve the last successful output.
    await writeFile(
      join(options.directory, '0004_partition.up.sql'),
      'CREATE TABLE "Partitioned" (id INTEGER) PARTITION BY RANGE (id); -- edited after applying',
    );
    await assert.rejects(
      run(process.execPath, [cli, 'generate', ...args, '--out', output], { env }),
    );
    assert.equal(await readFile(output, 'utf8'), withPartition);
  });
});

test('flags for other commands reject before changing files or the database', async () => {
  await project(recordMigrations, async (options) => {
    const env = { ...process.env, DATABASE_URL: connection };
    const common = ['--directory', options.directory, '--namespace', options.namespace];
    for (const args of [
      ['migrate', '--check'],
      ['migrate', '--steps', '2'],
      ['status', '--out', join(options.directory, 'unexpected.ts')],
      ['baseline', 'adopt', '--schema', 'public'],
      ['new', 'unexpected', '--check'],
    ]) {
      await assert.rejects(run(process.execPath, [cli, ...args, ...common], { env }));
    }
    const { rows } = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [
      options.namespace,
    ]);
    assert.deepEqual(rows, []);
    await assert.rejects(readFile(join(options.directory, '0002_unexpected.up.sql')), {
      code: 'ENOENT',
    });
  });
});
