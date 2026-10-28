import { fixtureTransaction } from './helpers/database.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import {
  adoptBaseline,
  captureBaseline,
  generateDefinitions,
  migrate,
  migrationStatus,
} from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const pool = new Pool({ connectionString: testConnection });
before(() => assertTestDatabase(pool));
after(() => pool.end());

// An application can use a frozen checkpoint before its first adoption. These guards are
// deliberately test-local: Tenon doesn't know a legacy runner's ledger or schema contract.
test('scoped handover checks a frozen checkpoint, preserves existing rows and executes fresh dependencies', async () => {
  await migrationProject(pool)({}, async (options) => {
    const dependency = `${options.namespace}_dependency`;
    const accounts = qualified(options.namespace, 'accounts');
    const history = qualified(options.namespace, 'legacy_history');
    const provision = qualified(options.namespace, 'provision');
    const helper = qualified(dependency, 'next_id');
    await pool.query(
      `CREATE SCHEMA ${quote(options.namespace)}; CREATE SCHEMA ${quote(dependency)}`,
    );
    try {
      await pool.query(`
        CREATE TABLE ${qualified(dependency, 'unrelated')} (id integer PRIMARY KEY);
        INSERT INTO ${qualified(dependency, 'unrelated')} VALUES (99);
        CREATE FUNCTION ${helper}() RETURNS integer LANGUAGE sql AS 'SELECT 7';
        CREATE TABLE ${accounts} (id integer PRIMARY KEY, name text NOT NULL);
        INSERT INTO ${accounts} VALUES (1, 'existing');
        CREATE TABLE ${history} (id text PRIMARY KEY);
        INSERT INTO ${history} VALUES ('001'), ('002');
        CREATE FUNCTION ${provision}() RETURNS integer LANGUAGE sql
          SET search_path TO pg_catalog AS 'SELECT ${helper}()';
      `);
      const functions = async () => {
        const rows = await fixtureTransaction(pool, async (client) => {
          await client.query('SET LOCAL search_path TO pg_catalog');
          return client.query<{ definition: string }>(
            `
            SELECT pg_catalog.pg_get_functiondef(p.oid) AS definition
            FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname=$1 ORDER BY p.proname COLLATE "C", pg_catalog.pg_get_function_identity_arguments(p.oid) COLLATE "C"
          `,
            [options.namespace],
          );
        });
        return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      };
      const checkpoint = {
        definitions: await generateDefinitions(options),
        functions: await functions(),
        history: [{ id: '001' }, { id: '002' }],
      };
      await captureBaseline({
        ...options,
        connection: testConnection,
        schemas: [options.namespace],
      });
      const baseline = await readFile(join(options.directory, '0001_baseline.up.sql'), 'utf8');
      assert.ok(!baseline.includes(`CREATE SCHEMA "${dependency}"`));
      assert.ok(!baseline.includes('CREATE TABLE "' + dependency + '"."unrelated"'));
      const adoptChecked = async () => {
        const state = await migrationStatus(options);
        if (!state.applied.length) {
          assert.deepEqual(
            [...(await pool.query(`SELECT id FROM ${history} ORDER BY id`)).rows],
            checkpoint.history,
          );
          assert.equal(await generateDefinitions(options), checkpoint.definitions);
          assert.equal(await functions(), checkpoint.functions);
        }
        await adoptBaseline(options);
        return migrate(options);
      };
      await pool.query(`DELETE FROM ${history} WHERE id='002'`);
      await assert.rejects(adoptChecked(), assert.AssertionError);
      await pool.query(`INSERT INTO ${history} VALUES ('002')`);
      await pool.query(`ALTER TABLE ${accounts} ADD COLUMN drift text`);
      await assert.rejects(adoptChecked(), assert.AssertionError);
      await pool.query(`ALTER TABLE ${accounts} DROP COLUMN drift`);
      await pool.query(`CREATE OR REPLACE FUNCTION ${provision}() RETURNS integer LANGUAGE sql
        SET search_path TO pg_catalog AS 'SELECT 999'`);
      assert.equal(
        await generateDefinitions(options),
        checkpoint.definitions,
        'relation generation cannot detect function drift',
      );
      await assert.rejects(adoptChecked(), assert.AssertionError);
      assert.deepEqual((await migrationStatus(options)).applied, []);
      await pool.query(`CREATE OR REPLACE FUNCTION ${provision}() RETURNS integer LANGUAGE sql
        SET search_path TO pg_catalog AS 'SELECT ${helper}()'`);
      await writeFile(
        join(options.directory, '0002_active.up.sql'),
        'ALTER TABLE accounts ADD COLUMN active boolean NOT NULL DEFAULT true;',
      );
      assert.deepEqual(await adoptChecked(), ['0002']);
      assert.deepEqual(
        await adoptChecked(),
        [],
        'later migrations do not change the frozen cutover guard',
      );
      assert.deepEqual(
        [...(await pool.query(`SELECT * FROM ${accounts}`)).rows],
        [{ id: 1, name: 'existing', active: true }],
      );
      const definitions = await generateDefinitions(options);
      await pool.query(
        `DROP SCHEMA ${quote(options.namespace)} CASCADE; DROP FUNCTION ${helper}()`,
      );
      await migrate(options);
      assert.equal(await generateDefinitions(options), definitions);
      await assert.rejects(pool.query(`SELECT ${provision}()`), { code: '42883' });
      // A scoped dump does not provision dependencies in another schema.
      await pool.query(`CREATE FUNCTION ${helper}() RETURNS integer LANGUAGE sql AS 'SELECT 7'`);
      assert.deepEqual([...(await pool.query(`SELECT ${provision}() AS id`)).rows], [{ id: 7 }]);
      assert.deepEqual([...(await pool.query(`SELECT * FROM ${accounts}`)).rows], []);
      assert.deepEqual(
        [...(await pool.query(`SELECT * FROM ${qualified(dependency, 'unrelated')}`)).rows],
        [{ id: 99 }],
      );
    } finally {
      await pool.query(`DROP SCHEMA ${quote(dependency)} CASCADE`);
    }
  });
});
