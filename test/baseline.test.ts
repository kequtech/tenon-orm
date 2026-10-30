import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPool, type Pool } from '@kequtech/pgclear';
import {
  adoptBaseline,
  captureBaseline,
  createTenon,
  generateDefinitions,
  migrate,
  migrationStatus,
  readMigrations,
  rollback,
} from '../src/index.js';
import { qualified, quote } from '../src/sql.js';

import { assertTestDatabase, testConnection as connection } from './helpers/database.js';
const pool = createPool({ connectionString: connection, maxConnections: 1 });
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = promisify(execFile);
before(() => assertTestDatabase(pool));
after(async () => {
  await pool.close();
});

async function project(
  work: (options: {
    connection: string;
    namespace: string;
    directory: string;
    schemas: string[];
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-baseline-test-'));
  const namespace = `tenon_baseline_${randomUUID().replaceAll('-', '')}`;
  try {
    await pool.queryClassic(`CREATE SCHEMA ${quote(namespace)}`, []);
    await work({ connection, namespace, directory, schemas: [namespace] });
  } finally {
    try {
      await pool.queryClassic(`DROP SCHEMA IF EXISTS ${quote(namespace)} CASCADE`, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

test('capture, adoption, future migrations and fresh replay share one baseline without changing live data', async () => {
  await project(async (options) => {
    const table = qualified(options.namespace, 'Customer');
    const oldHistory = qualified(options.namespace, '_old_migrations');
    await pool.withSession((session) =>
      session.script(`CREATE TABLE ${table} (id integer GENERATED ALWAYS AS IDENTITY (START WITH 100) PRIMARY KEY, name text NOT NULL DEFAULT 'customer');
      CREATE TABLE ${oldHistory} (name text PRIMARY KEY);
      INSERT INTO ${table} (name) VALUES ('existing');
      INSERT INTO ${oldHistory} VALUES ('legacy_001');
      CREATE VIEW ${qualified(options.namespace, 'CustomerNames')} AS SELECT name FROM ${table};
      CREATE FUNCTION ${qualified(options.namespace, 'increment')}(value integer) RETURNS integer LANGUAGE sql
        BEGIN ATOMIC SELECT value + 1; END;
      CREATE FUNCTION ${qualified(options.namespace, 'literal')}() RETURNS text LANGUAGE sql
        AS $body$SELECT E'\\nCREATE SCHEMA "${options.namespace}";\\n\\\\restrict literal\\n'::text$body$;`),
    );
    const original = (await pool.queryClassic(`SELECT * FROM ${table}`, [])).rows;
    const captured = await captureBaseline(options);
    await assert.rejects(
      adoptBaseline({ ...options, namespace: `${options.namespace}_missing` }),
      /namespace does not exist/,
    );
    assert.deepEqual(captured, {
      id: '0001',
      upPath: join(options.directory, '0001_baseline.up.sql'),
    });
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${table}`, [])).rows],
      [...original],
    );
    assert.equal(
      (
        await pool.queryClassic('SELECT to_regclass($1) AS name', [
          qualified(options.namespace, '__tenon_migrations'),
        ])
      ).rows[0]!.name,
      null,
    );
    assert.deepEqual(await readdir(options.directory), ['0001_baseline.up.sql']);
    assert.deepEqual(await adoptBaseline(options), ['0001']);
    assert.deepEqual(await adoptBaseline(options), []);
    assert.deepEqual(await migrate(options), []);
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${table}`, [])).rows],
      [...original],
    );
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${oldHistory}`, [])).rows],
      [{ name: 'legacy_001' }],
    );
    assert.deepEqual(
      [...(await pool.queryClassic(`INSERT INTO ${table} DEFAULT VALUES RETURNING id`, [])).rows],
      [{ id: 101 }],
    );
    const files = await readMigrations(options.directory);
    assert.deepEqual(
      [
        ...(
          await pool.queryClassic(
            `SELECT id, checksum FROM ${qualified(options.namespace, '__tenon_migrations')}`,
            [],
          )
        ).rows,
      ],
      [{ id: '0001', checksum: files[0]!.checksum }],
    );
    await assert.rejects(rollback(options), /no down SQL/);
    await writeFile(
      join(options.directory, '0002_active.up.sql'),
      'ALTER TABLE "Customer" ADD COLUMN active boolean NOT NULL DEFAULT true;',
    );
    await writeFile(
      join(options.directory, '0002_active.down.sql'),
      'ALTER TABLE "Customer" DROP COLUMN active;',
    );
    assert.deepEqual(await migrate(options), ['0002']);
    assert.deepEqual(await adoptBaseline(options), []);
    const definitions = await generateDefinitions(options);
    assert.deepEqual(await rollback(options), ['0002']);
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${table} ORDER BY id`, [])).rows],
      [
        { id: 100, name: 'existing' },
        { id: 101, name: 'customer' },
      ],
    );

    // Exercise Tenon's pg_dump/pgclear adapter and history transaction, not a schema
    // comparison system or a reimplementation of PostgreSQL's export guarantees.
    await pool.queryClassic(`DROP SCHEMA ${quote(options.namespace)} CASCADE`, []);
    const settings = `SELECT current_setting('search_path') AS path,
      current_setting('statement_timeout') AS timeout, current_setting('check_function_bodies') AS bodies`;
    const before = (await pool.queryClassic(settings, [])).rows;
    assert.deepEqual(await migrate({ ...options, connection: pool }), ['0001', '0002']);
    assert.deepEqual([...(await pool.queryClassic(settings, [])).rows], [...before]);
    assert.equal(await generateDefinitions(options), definitions);
    assert.deepEqual([...(await pool.queryClassic(`SELECT * FROM ${table}`, [])).rows], []);
    assert.deepEqual([...(await pool.queryClassic(`SELECT * FROM ${oldHistory}`, [])).rows], []);
    assert.deepEqual(
      [
        ...(
          await pool.queryClassic(
            `SELECT ${qualified(options.namespace, 'increment')}(2) AS value`,
            [],
          )
        ).rows,
      ],
      [{ value: 3 }],
    );
    assert.deepEqual(
      [
        ...(
          await pool.queryClassic(
            `SELECT ${qualified(options.namespace, 'literal')}() AS value`,
            [],
          )
        ).rows,
      ],
      [{ value: `\nCREATE SCHEMA "${options.namespace}";\n\\restrict literal\n` }],
    );
    assert.deepEqual(
      [
        ...(
          await pool.queryClassic(
            `SELECT * FROM ${qualified(options.namespace, 'CustomerNames')}`,
            [],
          )
        ).rows,
      ],
      [],
    );
    await assert.rejects(rollback({ ...options, steps: 2 }), /no down SQL/);
  });
});

test('concurrent pre-start adoption and migration are repeatable and edited baseline history rejects', async () => {
  await project(async (options) => {
    await pool.queryClassic(
      `CREATE TABLE ${qualified(options.namespace, 'Record')} (id integer)`,
      [],
    );
    await captureBaseline(options);
    await writeFile(
      join(options.directory, '0002_name.up.sql'),
      'ALTER TABLE "Record" ADD COLUMN name text;',
    );
    const results = await Promise.all(
      [1, 2].map(async () => ({
        adopted: await adoptBaseline(options),
        migrated: await migrate(options),
      })),
    );
    assert.deepEqual(
      results.flatMap((result) => result.adopted),
      ['0001'],
    );
    assert.deepEqual(
      results.flatMap((result) => result.migrated),
      ['0002'],
    );
    assert.deepEqual(await migrationStatus(options), { applied: ['0001', '0002'], pending: [] });
    const baseline = join(options.directory, '0001_baseline.up.sql');
    await writeFile(baseline, (await readFile(baseline, 'utf8')) + '\n-- edited\n');
    await assert.rejects(adoptBaseline(options), /history differs/);
    await assert.rejects(migrate(options), /history differs/);
  });
});

test('capture failures preserve existing files and release the creation lock', async () => {
  await project(async (options) => {
    const initial = join(options.directory, '0001_existing.up.sql');
    await writeFile(initial, 'SELECT 1;');
    await assert.rejects(captureBaseline(options), /empty Tenon migration directory/);
    assert.equal(await readFile(initial, 'utf8'), 'SELECT 1;');
    await rm(initial);
    await assert.rejects(
      captureBaseline({ ...options, schemas: [`${options.namespace}_missing`] }),
      /pg_dump failed/,
    );
    assert.deepEqual(await readdir(options.directory), []);
    const captured = await captureBaseline(options);
    await assert.rejects(captureBaseline(options), /empty Tenon migration directory/);
    assert.ok((await readFile(captured.upPath, 'utf8')).length > 0);
    await writeFile(join(options.directory, '0001_baseline.down.sql'), 'SELECT 1;');
    await assert.rejects(adoptBaseline(options), /no down file/);
  });
});

test('baseline CLI captures and adopts without replaying live data or exposing credentials', async () => {
  await project(async (options) => {
    const args = ['--directory', options.directory, '--namespace', options.namespace];
    const env = { ...process.env, DATABASE_URL: connection };
    const table = qualified(options.namespace, 'LiveRecord');
    await pool.withSession((session) =>
      session.script(`CREATE TABLE ${table} (id integer PRIMARY KEY, value text);
      INSERT INTO ${table} VALUES (1, 'existing data')`),
    );
    const original = (await pool.queryClassic(`SELECT * FROM ${table}`, [])).rows;

    await run(
      process.execPath,
      [cli, 'baseline', 'capture', ...args, '--schema', options.namespace],
      { env },
    );
    assert.deepEqual(await migrationStatus(options), { applied: [], pending: ['0001'] });
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${table}`, [])).rows],
      [...original],
    );

    await run(process.execPath, [cli, 'baseline', 'adopt', ...args], { env });
    assert.deepEqual(await migrationStatus(options), { applied: ['0001'], pending: [] });
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${table}`, [])).rows],
      [...original],
    );
    await run(process.execPath, [cli, 'baseline', 'adopt', ...args], { env });
    assert.deepEqual(await migrationStatus(options), { applied: ['0001'], pending: [] });
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${table}`, [])).rows],
      [...original],
    );
    const db = createTenon({ connection: pool });
    try {
      const generation = {
        namespace: options.namespace,
        out: join(options.directory, 'definitions.ts'),
      };
      await db.generateTypes(generation);
      await db.generateTypes({ ...generation, check: true });
    } finally {
      await db.close();
    }
    await rm(join(options.directory, '0001_baseline.up.sql'));
    await assert.rejects(
      run(process.execPath, [cli, 'baseline', 'capture', ...args, '--schema', options.namespace], {
        env: { ...env, DATABASE_URL: 'postgresql://postgres:secret_for_test@localhost:1/missing' },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error && 'stderr' in error);
        assert.ok('code' in error && error.code === 1);
        assert.ok(String(error.stderr).trim());
        assert.ok(!String(error.stderr).includes('secret_for_test'));
        return true;
      },
    );
    await assert.rejects(
      run(process.execPath, [cli, 'baseline', 'capture', ...args, '--schema', options.namespace], {
        env: { ...env, PATH: options.directory },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error && 'stderr' in error);
        assert.ok('code' in error && error.code === 1);
        assert.ok(String(error.stderr).trim());
        return true;
      },
    );
    assert.ok(
      !(await readdir(options.directory)).some(
        (file) => file.endsWith('.sql') || file.endsWith('.lock'),
      ),
    );
  });
});
