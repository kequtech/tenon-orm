import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createPool } from '@kequtech/pgclear';
import { captureBaseline, migrate } from '../../src/index.js';
import { qualified, quote } from '../../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from '../helpers/database.js';

test('PostgreSQL 18 capture replays fresh on PostgreSQL 16 without changing SQL object bodies', async () => {
  const sourceConnection = process.env.TENON_BASELINE_SOURCE_DATABASE_URL;
  assert.ok(
    sourceConnection,
    'Set TENON_BASELINE_SOURCE_DATABASE_URL to an isolated PostgreSQL 18 tenon_orm_test database.',
  );
  const source = createPool(sourceConnection);
  const target = createPool(testConnection);
  try {
    assert.match(await assertTestDatabase(source), /^18\./);
    assert.match(await assertTestDatabase(target), /^16\./);
    await migrationProject(target)({}, async (options) => {
      const table = qualified(options.namespace, 'records');
      const fn = qualified(options.namespace, 'literal');
      try {
        await source.queryClassic(`CREATE SCHEMA ${quote(options.namespace)}`);
        await source.queryClassic(`CREATE TABLE ${table} (id integer DEFAULT 42)`);
        await source.queryClassic(`INSERT INTO ${table} VALUES (99)`);
        await source.queryClassic(`CREATE FUNCTION ${fn}() RETURNS text LANGUAGE sql AS $body$
          SELECT $value$
SET LOCAL transaction_timeout = 0;
$value$::text
        $body$`);
        const captured = await captureBaseline({
          ...options,
          connection: sourceConnection,
          schemas: [options.namespace],
        });
        const saved = await Promise.all([
          readFile(captured.upPath),
          readFile(captured.checkpointPath),
        ]);
        assert.deepEqual(await migrate(options), ['0001']);
        assert.equal((await target.queryClassic(`SELECT * FROM ${table}`)).rows.length, 0);
        assert.equal(
          (await target.queryClassic(`INSERT INTO ${table} DEFAULT VALUES RETURNING id`)).rows[0]!
            .id,
          42,
        );
        const query = `SELECT ${fn}() AS value`;
        const original = (await source.queryClassic(query)).rows[0]!.value;
        assert.equal(original, '\nSET LOCAL transaction_timeout = 0;\n');
        assert.equal((await target.queryClassic(query)).rows[0]!.value, original);
        assert.deepEqual(
          await Promise.all([readFile(captured.upPath), readFile(captured.checkpointPath)]),
          saved,
        );
      } finally {
        await source.queryClassic(`DROP SCHEMA IF EXISTS ${quote(options.namespace)} CASCADE`);
      }
    });
  } finally {
    await source.close();
    await target.close();
  }
});
