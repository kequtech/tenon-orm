import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createPool } from '@kequtech/pgclear';
import { captureBaseline, migrate, readMigrations } from '../src/index.js';
import { baselineHeader, prepareBaselineSql } from '../src/migrations/baseline-sql.js';
import { checkpointHash, type BaselineCheckpoint } from '../src/migrations/checkpoint.js';
import { qualified, quote } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const pool = createPool({ connectionString: testConnection, maxConnections: 1 });
before(() => assertTestDatabase(pool));
after(() => pool.close());

test('new dump timeout preambles replay on older servers and stay transaction-local on supported servers', async () => {
  await migrationProject(pool)({}, async (options) => {
    const table = qualified(options.namespace, 'records');
    const sql = prepareBaselineSql(
      `SET transaction_timeout = 0;
-- Name: ${options.namespace}; Type: SCHEMA; Schema: -; Owner: -
CREATE SCHEMA ${quote(options.namespace)};
-- Name: records; Type: TABLE; Schema: ${options.namespace}; Owner: -
CREATE TABLE ${table} (id integer DEFAULT 42);
`,
      options.namespace,
    );
    await pool.withSession(async (client) => {
      const timeout = async () =>
        (
          await client.queryClassic<{ value: string | null }>(
            "SELECT pg_catalog.current_setting('transaction_timeout', true) AS value",
          )
        ).rows[0]!.value;
      const original = await timeout();
      let inTransaction = false;
      try {
        if (original !== null)
          await client.queryClassic(
            "SELECT pg_catalog.set_config('transaction_timeout', '30s', false)",
          );
        const configured = await timeout();
        await client.queryClassic('BEGIN');
        inTransaction = true;
        await client.script(sql);
        assert.equal(await timeout(), original === null ? null : '0');
        assert.equal(
          (await client.queryClassic(`INSERT INTO ${table} DEFAULT VALUES RETURNING id`)).rows[0]!
            .id,
          42,
        );
        await client.queryClassic('COMMIT');
        inTransaction = false;
        assert.equal(await timeout(), configured);
      } finally {
        if (inTransaction) await client.queryClassic('ROLLBACK');
        if (original !== null)
          await client.queryClassic(
            "SELECT pg_catalog.set_config('transaction_timeout', $1, false)",
            [original],
          );
      }
    });
  });
});

test('older captured pairs replay newer timeout boilerplate without changing files, checksums or object bodies', async () => {
  await migrationProject(pool)({}, async (options) => {
    const table = qualified(options.namespace, 'records');
    const fn = qualified(options.namespace, 'literal');
    await pool.queryClassic(`CREATE SCHEMA ${quote(options.namespace)}`);
    await pool.queryClassic(`CREATE TABLE ${table} (id integer DEFAULT 42)`);
    await pool.queryClassic(`CREATE FUNCTION ${fn}() RETURNS text LANGUAGE sql AS $body$
      SELECT $value$
SET LOCAL transaction_timeout = 0;
$value$::text
    $body$`);
    const captured = await captureBaseline({
      ...options,
      connection: testConnection,
      schemas: [options.namespace],
    });
    // Model a pre-0.6.2 pair captured with a newer pg_dump, before this normalization existed.
    const legacySql = (await readFile(captured.upPath, 'utf8')).replace(
      baselineHeader,
      baselineHeader + 'SET LOCAL transaction_timeout = 0;\n',
    );
    await writeFile(captured.upPath, legacySql);
    const [migration] = await readMigrations(options.directory);
    const { fingerprint: _, ...checkpoint } = JSON.parse(
      await readFile(captured.checkpointPath, 'utf8'),
    ) as BaselineCheckpoint & { fingerprint: string };
    const legacyCheckpoint = { ...checkpoint, migrationChecksum: migration!.checksum };
    await writeFile(
      captured.checkpointPath,
      JSON.stringify({ ...legacyCheckpoint, fingerprint: checkpointHash(legacyCheckpoint) }),
    );
    const saved = await Promise.all([readFile(captured.upPath), readFile(captured.checkpointPath)]);
    await pool.queryClassic(`DROP SCHEMA ${quote(options.namespace)} CASCADE`);
    assert.deepEqual(await migrate(options), ['0001']);
    assert.equal(
      (await pool.queryClassic(`INSERT INTO ${table} DEFAULT VALUES RETURNING id`)).rows[0]!.id,
      42,
    );
    assert.equal(
      (await pool.queryClassic(`SELECT ${fn}() AS value`)).rows[0]!.value,
      '\nSET LOCAL transaction_timeout = 0;\n',
    );
    assert.equal(
      (
        await pool.queryClassic(
          `SELECT checksum FROM ${qualified(options.namespace, '__tenon_migrations')} WHERE id = '0001'`,
        )
      ).rows[0]!.checksum,
      migration!.checksum,
    );
    assert.deepEqual(
      await Promise.all([readFile(captured.upPath), readFile(captured.checkpointPath)]),
      saved,
    );
  });
});
