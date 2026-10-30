import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { createPool } from '@kequtech/pgclear';
import { generateDefinitions, migrate } from '../src/index.js';
import { writeDefinitions } from '../src/generation/output.js';
import { qualified } from '../src/sql.js';
import { recordMigrations } from './fixtures/record-migrations.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';
import { writeConfig } from './helpers/config.js';

const pool = createPool(testConnection);
const project = migrationProject(pool);
const run = promisify(execFile);
const cli = resolve('dist/cli.js');
before(() => assertTestDatabase(pool));
after(() => pool.close());

test('generation CLI writes exact definitions and checks freshness without changing files', async () => {
  await project(recordMigrations, async (options) => {
    await migrate(options);
    const out = join(options.directory, 'generated/definitions.d.ts');
    await writeConfig(options.directory, {
      connection: testConnection,
      generate: { namespace: options.namespace, out },
    });
    const generate = (...flags: string[]) =>
      run(process.execPath, [cli, 'generate', ...flags], { cwd: options.directory });
    await assert.rejects(generate('--check'), /file is missing/);
    await assert.rejects(stat(join(options.directory, 'generated')), { code: 'ENOENT' });
    await generate();
    const first = await readFile(out, 'utf8');
    assert.equal(first, await generateDefinitions(options));
    const saved = await stat(out);
    await generate('--check');
    assert.equal((await stat(out)).mtimeMs, saved.mtimeMs);
    await pool.queryClassic(
      `ALTER TABLE ${qualified(options.namespace, 'Record')} ALTER COLUMN name SET DEFAULT 'draft'`,
    );
    await assert.rejects(generate('--check'), (error) => {
      assert.ok(error instanceof Error && 'stderr' in error);
      const diagnostic = String(error.stderr);
      assert.match(diagnostic, /Generated definitions differ:/);
      assert.match(diagnostic, /Diff excerpt from line/);
      assert.match(diagnostic, /^- .*"name" text NOT NULL$/m);
      assert.match(diagnostic, /^\+ .*"name" text NOT NULL DEFAULT 'draft'::text$/m);
      return true;
    });
    assert.equal(await readFile(out, 'utf8'), first);
    await generate();
    const updated = await readFile(out, 'utf8');
    assert.notEqual(updated, first);
    await writeFile(
      join(options.directory, '0002_column.up.sql'),
      'ALTER TABLE "Record" ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT false;',
    );
    await generate('--check');
    await migrate(options);
    await assert.rejects(generate('--check'), /definitions differ/);
    assert.equal(await readFile(out, 'utf8'), updated);
    await generate();
    const latest = await readFile(out, 'utf8');
    for (const flags of [[], ['--check']]) {
      await assert.rejects(
        generate('--namespace', `${options.namespace}_missing`, ...flags),
        /does not exist/,
      );
    }
    assert.equal(await readFile(out, 'utf8'), latest);
    assert.deepEqual(await readdir(join(options.directory, 'generated')), ['definitions.d.ts']);
  });
});

test('file output preserves filesystem failures and cleans temporary files after a failed rename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-output-'));
  const out = join(directory, 'existing-directory');
  try {
    await mkdir(out);
    await writeFile(join(out, 'retained'), 'original');
    await assert.rejects(writeDefinitions('new', out, true), { code: 'EISDIR' });
    await assert.rejects(writeDefinitions('new', out, false));
    assert.equal(await readFile(join(out, 'retained'), 'utf8'), 'original');
    assert.deepEqual(await readdir(directory), ['existing-directory']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
