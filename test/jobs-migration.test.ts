import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { jobsMigration } from '@kequtech/pgclear-jobs/migrations';
import { createJobsMigration, createMigration, readMigrations } from '../src/index.js';

async function fixture(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-jobs-files-'));
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Jobs setup copies canonical SQL beside app migrations and never rewrites historical SQL', async () => {
  await fixture(async (directory) => {
    const app = await createMigration({ name: 'app', directory });
    await writeFile(app.upPath, 'SELECT 1;');
    await writeFile(app.downPath, 'SELECT 2;');
    const generated = await createJobsMigration({ directory });
    assert.equal(generated.id, '0002');
    assert.equal(generated.created, true);
    const up = await readFile(generated.upPath, 'utf8');
    const down = await readFile(generated.downPath, 'utf8');
    assert.ok(up.endsWith(jobsMigration.up));
    assert.ok(down.endsWith(jobsMigration.down));
    const files = await readMigrations(directory);
    assert.equal(files.length, 2);
    assert.deepEqual(await createJobsMigration({ directory }), { ...generated, created: false });
    assert.equal((await readMigrations(directory))[1]!.checksum, files[1]!.checksum);
    // Simulate historical SQL differing from the currently installed package.
    const oldUp = up.slice(0, up.indexOf('\n') + 1) + 'SELECT 42;\n';
    await writeFile(generated.upPath, oldUp);
    const renamedUp = join(directory, '0002_original_jobs.up.sql');
    const renamedDown = join(directory, '0002_original_jobs.down.sql');
    await rename(generated.upPath, renamedUp);
    await rename(generated.downPath, renamedDown);
    assert.deepEqual(await createJobsMigration({ directory }), {
      id: '0002',
      upPath: renamedUp,
      downPath: renamedDown,
      created: false,
    });
    assert.equal(await readFile(renamedUp, 'utf8'), oldUp);
    assert.equal(await readFile(renamedDown, 'utf8'), down);
    assert.equal((await readdir(directory)).length, 4);
  });
});

test('Jobs setup refuses incomplete, conflicting and duplicate pairs without writing files', async () => {
  await fixture(async (directory) => {
    const first = await createJobsMigration({ directory });
    const up = await readFile(first.upPath, 'utf8');
    await rm(first.downPath);
    await assert.rejects(createJobsMigration({ directory }), /Incomplete Jobs migration pair/);
    assert.equal((await readdir(directory)).length, 1);
    await writeFile(first.upPath, 'SELECT 1;');
    await assert.rejects(createJobsMigration({ directory }), /conflicting Jobs migration/);
    assert.equal(await readFile(first.upPath, 'utf8'), 'SELECT 1;');
    await writeFile(first.upPath, up);
    await writeFile(first.downPath, up);
    await writeFile(join(directory, '0002_duplicate.up.sql'), up);
    await assert.rejects(createJobsMigration({ directory }), /Multiple Jobs setup migrations/);
  });
});

test('Jobs setup respects the shared creation lock and numbers existing empty drafts', async () => {
  await fixture(async (directory) => {
    await createMigration({ name: 'draft', directory });
    await writeFile(join(directory, '.tenon-create.lock'), 'locked');
    await assert.rejects(createJobsMigration({ directory }), /creation lock exists/);
    await rm(join(directory, '.tenon-create.lock'));
    assert.equal((await createJobsMigration({ directory })).id, '0002');
  });
});

test('jobs setup CLI uses configured directory and selected database without credentials', async () => {
  await fixture(async (root) => {
    const config = join(root, 'tenon.config.mjs');
    await writeFile(
      config,
      `export const main = {connection: undefined, migrations: {directory: 'app'}}; export const other = {connection: undefined, migrations: {directory: 'other'}};`,
    );
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const run = (...extra: string[]) =>
      promisify(execFile)(
        process.execPath,
        [cli, 'jobs', 'setup', '--config', config, '--database', 'main', ...extra],
        { env, cwd: root },
      );
    await run();
    assert.equal((await readMigrations(join(root, 'app'))).length, 1);
    await run();
    assert.equal((await readMigrations(join(root, 'app'))).length, 1);
    await run('--directory', join(root, 'override'));
    assert.equal((await readMigrations(join(root, 'override'))).length, 1);
    await assert.rejects(run('--namespace', 'other'));
  });
});

for (const renamed of [false, true]) {
  test(`Jobs setup recognizes ${renamed ? 'renamed' : 'original'} files with Windows line endings and a BOM`, async () => {
    await fixture(async (directory) => {
      const generated = await createJobsMigration({ directory });
      const up = '\uFEFF' + (await readFile(generated.upPath, 'utf8')).replaceAll('\n', '\r\n');
      const down = (await readFile(generated.downPath, 'utf8')).replaceAll('\n', '\r\n');
      const upPath = renamed ? join(directory, '0001_jobs_initial.up.sql') : generated.upPath;
      const downPath = renamed ? join(directory, '0001_jobs_initial.down.sql') : generated.downPath;
      await writeFile(generated.upPath, up);
      await writeFile(generated.downPath, down);
      if (renamed) {
        await rename(generated.upPath, upPath);
        await rename(generated.downPath, downPath);
      }
      await readMigrations(directory);
      assert.deepEqual(await createJobsMigration({ directory }), {
        id: generated.id,
        upPath,
        downPath,
        created: false,
      });
      assert.equal(await readFile(upPath, 'utf8'), up);
      assert.equal(await readFile(downPath, 'utf8'), down);
      assert.equal((await readdir(directory)).length, 2);
    });
  });
}
