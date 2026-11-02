import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPool } from '@kequtech/pgclear';
import { captureBaseline, inspectSchema, migrate, migrationStatus } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const pool = createPool(testConnection);
before(() => assertTestDatabase(pool));
after(() => pool.close());
const run = promisify(execFile);
const example = fileURLToPath(new URL('../examples/adopt-baseline.js', import.meta.url));

test('adoption example rejects drift before recording history and preserves data on matching adoption', async () => {
  await migrationProject(pool)({}, async (options) => {
    const table = qualified(options.namespace, 'records');
    await pool.queryClassic(`CREATE SCHEMA ${quote(options.namespace)}`);
    await pool.queryClassic(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
    await pool.queryClassic(`INSERT INTO ${table} VALUES (1)`);
    const baseline = await captureBaseline({
      ...options,
      connection: testConnection,
      schemas: [options.namespace],
    });
    const savedSql = await readFile(baseline.upPath, 'utf8');
    // Derive the reference from an independent empty replay in the same namespace, not the target.
    const checkpoint = join(options.directory, 'checkpoint.json');
    await pool.queryClassic(`DROP SCHEMA ${quote(options.namespace)} CASCADE`);
    await migrate(options);
    await writeFile(
      checkpoint,
      JSON.stringify(await inspectSchema({ connection: pool, namespace: options.namespace })),
    );
    await pool.queryClassic(`DROP SCHEMA ${quote(options.namespace)} CASCADE`);
    await pool.queryClassic(`CREATE SCHEMA ${quote(options.namespace)}`);
    await pool.queryClassic(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
    await pool.queryClassic(`INSERT INTO ${table} VALUES (1)`);
    const execute = () =>
      run(process.execPath, [example, checkpoint, options.directory], {
        env: { ...process.env, DATABASE_URL: testConnection },
      });
    await pool.queryClassic(`ALTER TABLE ${table} ADD COLUMN drift text`);
    await assert.rejects(execute(), /Schema differs/);
    assert.deepEqual((await migrationStatus(options)).applied, []);
    await pool.queryClassic(`ALTER TABLE ${table} DROP COLUMN drift`);
    await writeFile(
      join(options.directory, '0002_name.up.sql'),
      'ALTER TABLE records ADD COLUMN name text;',
    );
    await execute();
    assert.deepEqual((await migrationStatus(options)).applied, ['0001', '0002']);
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${table}`)).rows],
      [{ id: 1, name: null }],
    );
    assert.equal(await readFile(baseline.upPath, 'utf8'), savedSql);
  });
});
