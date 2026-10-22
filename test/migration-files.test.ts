import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createMigration, readMigrations } from '../src/index.js';
import { validateMigrationSql } from '../src/migrations/sql.js';

test('migration files use numeric ordering and reject duplicate versions or orphaned down files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-files-'));
  try {
    await writeFile(join(directory, '10_last.up.sql'), 'SELECT 10;');
    await writeFile(join(directory, '2_first.up.sql'), 'SELECT 2;');
    assert.deepEqual(
      (await readMigrations(directory)).map((file) => file.id),
      ['2', '10'],
    );
    await writeFile(join(directory, '02_duplicate.up.sql'), 'SELECT 2;');
    await assert.rejects(readMigrations(directory), /Duplicate migration version/);
    await rm(join(directory, '02_duplicate.up.sql'));
    await writeFile(join(directory, '3_orphan.down.sql'), 'SELECT 3;');
    await assert.rejects(readMigrations(directory), /without an up/);
    await rm(join(directory, '3_orphan.down.sql'));
    await writeFile(join(directory, 'typo.sql'), 'SELECT 1;');
    await assert.rejects(readMigrations(directory), /Invalid migration filename/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('transaction-control detection respects SQL strings, comments and dollar-quoted bodies', () => {
  assert.doesNotThrow(() =>
    validateMigrationSql(
      `-- COMMIT;
    DO $body$ BEGIN RAISE NOTICE 'COMMIT;'; END $body$;
    SELECT 'x; COMMIT;', E'escaped\\\'; ROLLBACK;', "COMMIT";
    /* outer /* COMMIT; */ comment */ SELECT 1;`,
      'valid.sql',
    ),
  );
  for (const sql of [
    'BEGIN;',
    '-- comment\nCOMMIT;',
    "SELECT 'safe'; /* comment */ ROLLBACK;",
    'START /* comment */ TRANSACTION;',
    "PREPARE TRANSACTION 'name';",
  ]) {
    assert.throws(() => validateMigrationSql(sql, 'invalid.sql'), /transaction-control/);
  }
  assert.throws(() => validateMigrationSql("SELECT 'unterminated", 'bad.sql'), /Unterminated/);
});

test('migration scaffolding creates empty pairs, numbers drafts and preserves existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-create-'));
  const directory = join(root, 'migrations');
  try {
    const first = await createMigration({ name: 'add_users', directory });
    assert.deepEqual(first, {
      id: '0001',
      upPath: join(directory, '0001_add_users.up.sql'),
      downPath: join(directory, '0001_add_users.down.sql'),
    });
    assert.equal(await readFile(first.upPath, 'utf8'), '');
    assert.equal(await readFile(first.downPath, 'utf8'), '');
    await assert.rejects(readMigrations(directory), /Empty migration/);
    const second = await createMigration({ name: 'add_users', directory });
    assert.equal(second.id, '0002');
    await writeFile(first.upPath, 'CREATE TABLE users (id integer);');
    await writeFile(first.downPath, 'DROP TABLE users;');
    await writeFile(second.upPath, 'ALTER TABLE users ADD COLUMN name text;');
    await writeFile(second.downPath, 'ALTER TABLE users DROP COLUMN name;');
    assert.deepEqual(
      (await readMigrations(directory)).map((migration) => migration.id),
      ['0001', '0002'],
    );
    const third = await createMigration({ name: 'add_posts', directory });
    assert.equal(third.id, '0003');
    assert.equal(await readFile(first.upPath, 'utf8'), 'CREATE TABLE users (id integer);');
    assert.equal(await readFile(second.downPath, 'utf8'), 'ALTER TABLE users DROP COLUMN name;');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration scaffolding uses numeric ordering without rounding large versions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-create-'));
  try {
    await writeFile(join(directory, '2_old.up.sql'), 'SELECT 2;');
    await writeFile(join(directory, '10_newer.up.sql'), 'SELECT 10;');
    assert.equal((await createMigration({ name: 'next', directory })).id, '0011');
    await writeFile(join(directory, '9007199254740993_large.up.sql'), 'SELECT 1;');
    assert.equal((await createMigration({ name: 'exact', directory })).id, '9007199254740994');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid migration names and an existing creation lock cannot overwrite files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-create-'));
  try {
    for (const name of ['', '../escape', 'name with spaces', 'name.up.sql'])
      await assert.rejects(createMigration({ name, directory }), /Migration names/);
    const lockPath = join(directory, '.tenon-create.lock');
    await writeFile(lockPath, 'another creator');
    await assert.rejects(createMigration({ name: 'blocked', directory }), /creation lock exists/);
    assert.equal(await readFile(lockPath, 'utf8'), 'another creator');
    await rm(lockPath);
    assert.equal((await createMigration({ name: 'allowed', directory })).id, '0001');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the migration creation CLI needs no DATABASE_URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-create-cli-'));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const env = { ...process.env };
  delete env.DATABASE_URL;
  try {
    await promisify(execFile)(
      process.execPath,
      [cli, 'new', 'add_users', '--directory', directory],
      { env },
    );
    assert.equal(await readFile(join(directory, '0001_add_users.up.sql'), 'utf8'), '');
    assert.equal(await readFile(join(directory, '0001_add_users.down.sql'), 'utf8'), '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('migration SQL handles carriage-return comments and dollar signs inside identifiers', () => {
  assert.throws(
    () => validateMigrationSql('-- comment\rCOMMIT;', 'bad.sql'),
    /transaction-control/,
  );
  assert.doesNotThrow(() =>
    validateMigrationSql('CREATE TABLE item$tag$ (id integer);', 'valid.sql'),
  );
  assert.throws(
    () => validateMigrationSql('SELECT item$tag$; COMMIT;', 'bad.sql'),
    /transaction-control/,
  );
});
