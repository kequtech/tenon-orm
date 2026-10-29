import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPool, type Pool } from '@kequtech/pgclear';
import { qualified } from '../src/sql.js';
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

test('CLI migration and .d.ts generation remain separate; check mode catches stale files without rewriting', async () => {
  await project(recordMigrations, async (options) => {
    const output = join(options.directory, 'generated', 'definitions.d.ts');
    const args = ['--directory', options.directory, '--namespace', options.namespace];
    const generation = ['--namespace', options.namespace, '--out', output];
    const env = { ...process.env, DATABASE_URL: connection };
    await run(process.execPath, [cli, 'migrate', ...args], { env });
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    await assert.rejects(
      run(process.execPath, [cli, 'generate', ...generation, '--check'], { env }),
      (error: unknown) => {
        assert.ok(error instanceof Error && 'stderr' in error);
        assert.ok('code' in error && error.code === 1);
        const diagnostic = String(error.stderr);
        assert.ok(diagnostic.includes(`Generated definitions file is missing: ${output}`));
        assert.ok(diagnostic.includes('tenon generate'));
        assert.ok(!diagnostic.includes('Diff excerpt'));
        return true;
      },
    );
    await assert.rejects(readFile(join(options.directory, 'generated')), { code: 'ENOENT' });
    await run(process.execPath, [cli, 'generate', ...generation], { env });
    const first = await readFile(output, 'utf8');
    const unchanged = await run(process.execPath, [cli, 'generate', ...generation, '--check'], {
      env,
    });
    assert.equal(unchanged.stdout, 'Generated definitions are current.\n');
    assert.equal(unchanged.stderr, '');
    await assert.rejects(
      run(
        process.execPath,
        [cli, 'generate', '--namespace', options.namespace, '--out', options.directory, '--check'],
        { env },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error && 'stderr' in error);
        assert.ok(String(error.stderr).includes('EISDIR'));
        assert.ok(!String(error.stderr).includes('file is missing'));
        assert.ok(!String(error.stderr).includes('definitions differ'));
        return true;
      },
    );
    await pool.queryClassic(
      `ALTER TABLE ${qualified(options.namespace, 'Record')} ALTER COLUMN name SET DEFAULT 'draft'`,
      [],
    );
    await assert.rejects(
      run(process.execPath, [cli, 'generate', ...generation, '--check'], { env }),
      (error: unknown) => {
        assert.ok(error instanceof Error && 'stderr' in error);
        assert.ok('code' in error && error.code === 1);
        const diagnostic = String(error.stderr);
        assert.ok(diagnostic.includes(`Generated definitions differ: ${output}`));
        assert.ok(diagnostic.includes('Diff excerpt from line'));
        assert.match(diagnostic, /^- .*"name" text NOT NULL$/m);
        assert.match(diagnostic, /^\+ .*"name" text NOT NULL DEFAULT 'draft'::text$/m);
        assert.ok(diagnostic.includes('tenon generate'));
        return true;
      },
    );
    assert.equal(await readFile(output, 'utf8'), first);
    await run(process.execPath, [cli, 'generate', ...generation], { env });
    assert.notEqual(await readFile(output, 'utf8'), first);
    await pool.queryClassic(
      `ALTER TABLE ${qualified(options.namespace, 'Record')} ALTER COLUMN name DROP DEFAULT`,
      [],
    );
    await run(process.execPath, [cli, 'generate', ...generation], { env });
    assert.equal(await readFile(output, 'utf8'), first);
    await writeFile(
      join(options.directory, '0002_column.up.sql'),
      'ALTER TABLE "Record" ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT false;',
    );
    // A pending migration changes neither the connected schema nor --check.
    await run(process.execPath, [cli, 'generate', ...generation, '--check'], { env });
    assert.equal(await readFile(output, 'utf8'), first);
    await run(process.execPath, [cli, 'migrate', ...args], { env });
    await assert.rejects(
      run(process.execPath, [cli, 'generate', ...generation, '--check'], { env }),
    );
    assert.equal(await readFile(output, 'utf8'), first);
    await run(process.execPath, [cli, 'generate', ...generation], { env });
    assert.notEqual(await readFile(output, 'utf8'), first);
    await writeFile(
      join(options.directory, '0003_unsupported.up.sql'),
      'ALTER TABLE "Record" ADD COLUMN amount INTERVAL;',
    );
    await run(process.execPath, [cli, 'migrate', ...args], { env });
    const unsupported = await run(process.execPath, [cli, 'generate', ...generation], {
      env,
    });
    assert.equal(unsupported.stderr, '');

    const withUnknown = await readFile(output, 'utf8');
    const current = await run(process.execPath, [cli, 'generate', ...generation, '--check'], {
      env,
    });
    assert.equal(current.stderr, '');
    assert.equal(await readFile(output, 'utf8'), withUnknown);
    await writeFile(
      join(options.directory, '0004_partition.up.sql'),
      'CREATE TABLE "Partitioned" (id INTEGER) PARTITION BY RANGE (id);',
    );
    await run(process.execPath, [cli, 'migrate', ...args], { env });
    await run(process.execPath, [cli, 'generate', ...generation], { env });
    const withPartition = await readFile(output, 'utf8');
    await run(process.execPath, [cli, 'generate', ...generation, '--check'], { env });
    await pool.queryClassic(
      `CREATE TABLE ${qualified(options.namespace, 'PartitionedDaily')}
      PARTITION OF ${qualified(options.namespace, 'Partitioned')} DEFAULT`,
      [],
    );
    await run(process.execPath, [cli, 'generate', ...generation, '--check'], { env });
    await pool.queryClassic(`DROP TABLE ${qualified(options.namespace, 'PartitionedDaily')}`, []);
    await run(process.execPath, [cli, 'generate', ...generation, '--check'], { env });
    assert.equal(await readFile(output, 'utf8'), withPartition);
    // Migration file edits do not affect schema introspection.
    await writeFile(
      join(options.directory, '0004_partition.up.sql'),
      'CREATE TABLE "Partitioned" (id INTEGER) PARTITION BY RANGE (id); -- edited after applying',
    );
    await run(process.execPath, [cli, 'generate', ...generation, '--check'], { env });
    // A misspelled namespace must fail without replacing the last good file.
    for (const check of [[], ['--check']]) {
      await assert.rejects(
        run(
          process.execPath,
          [
            cli,
            'generate',
            '--namespace',
            `${options.namespace}_missing`,
            '--out',
            output,
            ...check,
          ],
          { env },
        ),
      );
    }
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
