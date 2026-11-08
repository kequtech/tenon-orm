import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool } from '@kequtech/pgclear';
import { captureBaseline, migrate, migrationStatus } from '../src/index.js';
import { checkpointHash, type BaselineCheckpoint } from '../src/migrations/checkpoint.js';
import { qualified, quote } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const pool = createPool(testConnection);
before(() => assertTestDatabase(pool));
after(() => pool.close());

test('drift stops initial migrate before recording history or running later migrations', async () => {
  await migrationProject(pool)({}, async (options) => {
    const table = qualified(options.namespace, 'records');
    await pool.queryClassic(`CREATE SCHEMA ${quote(options.namespace)}`);
    await pool.queryClassic(
      `CREATE TABLE ${table} (id integer PRIMARY KEY, status text NOT NULL DEFAULT 'active')`,
    );
    await pool.queryClassic(`INSERT INTO ${table} (id) VALUES (1)`);
    const captured = await captureBaseline({
      ...options,
      connection: testConnection,
      schemas: [options.namespace],
    });
    const pair = await Promise.all([readFile(captured.upPath), readFile(captured.checkpointPath)]);
    await writeFile(
      join(options.directory, '0002_name.up.sql'),
      'ALTER TABLE records ADD COLUMN name text;',
    );
    await pool.queryClassic(`ALTER TABLE ${table} ALTER COLUMN status SET DEFAULT 'changed'`);
    await assert.rejects(migrate(options), /schemas[\s\S]*records[\s\S]*expression/);
    assert.deepEqual(await migrationStatus(options), { applied: [], pending: ['0001', '0002'] });
    assert.equal(
      (
        await pool.queryClassic('SELECT to_regclass($1) AS name', [
          qualified(options.namespace, '__tenon_migrations'),
        ])
      ).rows[0]!.name,
      null,
    );
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${table}`)).rows],
      [{ id: 1, status: 'active' }],
    );
    await pool.queryClassic(`ALTER TABLE ${table} ALTER COLUMN status SET DEFAULT 'active'`);
    assert.deepEqual(await migrate(options), ['0001', '0002']);
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${table}`)).rows],
      [{ id: 1, status: 'active', name: null }],
    );
    assert.deepEqual(
      await Promise.all([readFile(captured.upPath), readFile(captured.checkpointPath)]),
      pair,
    );
    // History makes later invocations independent of the initial-adoption checkpoint.
    await rm(captured.checkpointPath);
    assert.deepEqual(await migrate(options), []);
  });
});

test('missing, corrupt, edited and mismatched checkpoint pairs fail on fresh storage without DDL', async () => {
  await migrationProject(pool)({}, async (options) => {
    await pool.queryClassic(`CREATE SCHEMA ${quote(options.namespace)}`);
    await pool.queryClassic(`CREATE TABLE ${qualified(options.namespace, 'records')} (id integer)`);
    const captured = await captureBaseline({
      ...options,
      connection: testConnection,
      schemas: [options.namespace],
    });
    const original = await readFile(captured.checkpointPath, 'utf8');
    const sql = await readFile(captured.upPath, 'utf8');
    await pool.queryClassic(`DROP SCHEMA ${quote(options.namespace)} CASCADE`);
    for (const value of [
      undefined,
      '{}',
      '{broken',
      original.replace('"formatVersion": 1', '"formatVersion": 2'),
    ]) {
      if (value === undefined) await rm(captured.checkpointPath);
      else await writeFile(captured.checkpointPath, value);
      await assert.rejects(migrate(options), /checkpoint/i);
      assert.equal(
        (
          await pool.queryClassic('SELECT 1 FROM pg_namespace WHERE nspname = $1', [
            options.namespace,
          ])
        ).rows.length,
        0,
      );
    }
    await writeFile(captured.checkpointPath, original);
    await rm(captured.upPath);
    const later = join(options.directory, '0002_later.up.sql');
    await writeFile(later, 'CREATE TABLE should_not_exist (id integer);');
    await assert.rejects(migrate(options), /checkpoint has no matching captured/);
    assert.equal(
      (
        await pool.queryClassic('SELECT 1 FROM pg_namespace WHERE nspname = $1', [
          options.namespace,
        ])
      ).rows.length,
      0,
    );
    await rm(later);
    await writeFile(captured.upPath, sql + '\n-- edited SQL\n');
    await assert.rejects(migrate(options), /checkpoint does not match/);
    await writeFile(captured.upPath, sql);
    assert.deepEqual(await migrate(options), ['0001']);
    assert.deepEqual(
      [
        ...(await pool.queryClassic(`SELECT * FROM ${qualified(options.namespace, 'records')}`))
          .rows,
      ],
      [],
    );
  });
});

test('function-only and view-only schemas are checked, never mistaken for fresh storage', async () => {
  for (const kind of ['function', 'view']) {
    await migrationProject(pool)({}, async (options) => {
      const object = qualified(options.namespace, 'value');
      const definition = (value: number) =>
        kind === 'function'
          ? `CREATE OR REPLACE FUNCTION ${object}() RETURNS integer LANGUAGE sql AS 'SELECT ${value}'`
          : `CREATE OR REPLACE VIEW ${object} AS SELECT ${value} AS value`;
      await pool.queryClassic(`CREATE SCHEMA ${quote(options.namespace)}`);
      await pool.queryClassic(definition(1));
      await captureBaseline({
        ...options,
        connection: testConnection,
        schemas: [options.namespace],
      });
      await pool.queryClassic(definition(2));
      await assert.rejects(migrate(options), /Schema differs/);
      assert.deepEqual((await migrationStatus(options)).applied, []);
      await pool.queryClassic(definition(1));
      assert.deepEqual(await migrate(options), ['0001']);
      await pool.queryClassic(`DROP SCHEMA ${quote(options.namespace)} CASCADE`);
      assert.deepEqual(await migrate(options), ['0001']);
      const query =
        kind === 'function' ? `SELECT ${object}() AS value` : `SELECT value FROM ${object}`;
      assert.equal((await pool.queryClassic(query)).rows[0]!.value, 1);
    });
  }
});

test('automatic adoption accepts the narrow equivalent CHECK array casts and refuses changed values', async () => {
  await migrationProject(pool)({}, async (options) => {
    const table = qualified(options.namespace, 'records');
    await pool.queryClassic(`CREATE SCHEMA ${quote(options.namespace)}`);
    await pool.queryClassic(`CREATE TABLE ${table} (status varchar(16), CONSTRAINT status_check
      CHECK (status::text = ANY (ARRAY[('active'::varchar)::text, ('disabled'::varchar)::text])))`);
    await pool.queryClassic(`INSERT INTO ${table} VALUES ('active')`);
    await captureBaseline({ ...options, connection: testConnection, schemas: [options.namespace] });
    await pool.queryClassic(`ALTER TABLE ${table} DROP CONSTRAINT status_check,
      ADD CONSTRAINT status_check CHECK (status IN ('active', 'retired'))`);
    await assert.rejects(migrate(options), /Schema differs/);
    assert.deepEqual((await migrationStatus(options)).applied, []);
    await pool.queryClassic(`ALTER TABLE ${table} DROP CONSTRAINT status_check,
      ADD CONSTRAINT status_check CHECK (status IN ('active', 'disabled'))`);
    assert.deepEqual(await migrate(options), ['0001']);
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${table}`)).rows],
      [{ status: 'active' }],
    );
    await assert.rejects(pool.queryClassic(`INSERT INTO ${table} VALUES ('retired')`));
  });
});

test('partially initialized multi-schema storage refuses adoption and preserves unrelated schemas', async () => {
  await migrationProject(pool)({}, async (options) => {
    const secondary = options.namespace + '_second';
    try {
      await pool.queryClassic(`CREATE SCHEMA ${quote(options.namespace)}`);
      await pool.queryClassic(`CREATE SCHEMA ${quote(secondary)}`);
      for (const namespace of [options.namespace, secondary])
        await pool.queryClassic(`CREATE TABLE ${qualified(namespace, 'records')} (id integer)`);
      await captureBaseline({
        ...options,
        connection: testConnection,
        schemas: [options.namespace, secondary],
      });
      await pool.queryClassic(`DROP SCHEMA ${quote(secondary)} CASCADE`);
      await assert.rejects(migrate(options), /Schema differs/);
      assert.deepEqual((await migrationStatus(options)).applied, []);
      await pool.queryClassic(`DROP SCHEMA ${quote(options.namespace)} CASCADE`);
      // Both missing and pre-created empty application schemas are fresh.
      await pool.queryClassic(`CREATE SCHEMA ${quote(options.namespace)}`);
      assert.deepEqual(await migrate(options), ['0001']);
      for (const namespace of [options.namespace, secondary])
        assert.equal(
          (await pool.queryClassic(`SELECT * FROM ${qualified(namespace, 'records')}`)).rows.length,
          0,
        );
    } finally {
      await pool.queryClassic(`DROP SCHEMA IF EXISTS ${quote(secondary)} CASCADE`);
    }
  });
});

test('server version metadata does not block adoption or hide schema differences', async () => {
  await migrationProject(pool)({}, async (options) => {
    const table = qualified(options.namespace, 'records');
    await pool.queryClassic(`CREATE SCHEMA ${quote(options.namespace)}`);
    await pool.queryClassic(`CREATE TABLE ${table} (id integer)`);
    await pool.queryClassic(`INSERT INTO ${table} VALUES (7)`);
    const { checkpointPath } = await captureBaseline({
      ...options,
      connection: testConnection,
      schemas: [options.namespace],
    });
    const { fingerprint: _, ...checkpoint } = JSON.parse(
      await readFile(checkpointPath, 'utf8'),
    ) as BaselineCheckpoint & { fingerprint: string };
    const changed = {
      ...checkpoint,
      schemas: checkpoint.schemas.map((schema) => ({
        ...schema,
        postgresMajor: schema.postgresMajor + 1,
      })),
    };
    await writeFile(
      checkpointPath,
      JSON.stringify({ ...changed, fingerprint: checkpointHash(changed) }),
    );
    await pool.queryClassic(`ALTER TABLE ${table} ADD COLUMN drift text`);
    await assert.rejects(migrate(options), /Schema differs[\s\S]*drift/);
    assert.deepEqual((await migrationStatus(options)).applied, []);
    await pool.queryClassic(`ALTER TABLE ${table} DROP COLUMN drift`);
    await writeFile(
      join(options.directory, '0002_name.up.sql'),
      'ALTER TABLE records ADD COLUMN name text;',
    );
    assert.deepEqual(await migrate(options), ['0001', '0002']);
    assert.deepEqual(
      [...(await pool.queryClassic(`SELECT * FROM ${table}`)).rows],
      [{ id: 7, name: null }],
    );
  });
});

test('a whole-database checkpoint checks every captured user schema on matching and fresh storage', async () => {
  const name = `tenon_baseline_${randomUUID().replaceAll('-', '')}`;
  const connection = new URL(testConnection);
  connection.pathname = '/' + name;
  const directory = await mkdtemp(join(tmpdir(), 'tenon-whole-baseline-'));
  await pool.queryClassic(`CREATE DATABASE ${quote(name)}`);
  const isolated = createPool(connection.toString());
  try {
    await isolated.queryClassic('CREATE SCHEMA app');
    await isolated.queryClassic('CREATE TABLE app.records (id integer)');
    await isolated.queryClassic('INSERT INTO app.records VALUES (7)');
    const captured = await captureBaseline({ connection: connection.toString(), directory });
    const checkpoint = JSON.parse(
      await readFile(captured.checkpointPath, 'utf8'),
    ) as BaselineCheckpoint;
    assert.deepEqual(
      checkpoint.schemas.map((schema) => schema.namespace),
      ['app', 'public'],
    );
    const options = { connection: isolated, directory };
    assert.deepEqual(await migrate(options), ['0001']);
    assert.deepEqual(
      [...(await isolated.queryClassic('SELECT * FROM app.records')).rows],
      [{ id: 7 }],
    );
    await isolated.queryClassic('DROP SCHEMA app CASCADE');
    await isolated.queryClassic('DROP TABLE public.__tenon_migrations');
    assert.deepEqual(await migrate(options), ['0001']);
    assert.equal((await isolated.queryClassic('SELECT * FROM app.records')).rows.length, 0);
  } finally {
    await isolated.close();
    await pool.queryClassic(`DROP DATABASE ${quote(name)}`);
    await rm(directory, { recursive: true, force: true });
  }
});
