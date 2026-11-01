import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { builtin, createPool, defaultCodecs } from '@kequtech/pgclear';
import { inspectSchema, migrate } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';
import { writeConfig } from './helpers/config.js';

const run = promisify(execFile);
const pool = createPool({ connectionString: testConnection });
const project = migrationProject(pool);
before(() => assertTestDatabase(pool));
after(() => pool.close());

const fixture = {
  '0001_schema.up.sql': `CREATE TYPE state AS ENUM ('queued', 'done');
    CREATE DOMAIN positive AS integer CHECK (VALUE > 0);
    CREATE FUNCTION flag() RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE FUNCTION hashtextextended(text, bigint) RETURNS bigint LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'Application function must not implement catalog locking'; END $$;
    CREATE TABLE entries (
      id bigint GENERATED ALWAYS AS IDENTITY (START WITH 9007199254740993) PRIMARY KEY,
      state state NOT NULL DEFAULT 'queued', value positive, at timestamptz,
      active boolean DEFAULT flag(), label text COLLATE "C",
      instant timestamptz DEFAULT TIMESTAMPTZ '2026-01-02 03:04:05+00',
      day date DEFAULT DATE '2026-01-02', duration interval DEFAULT INTERVAL '1 day 2 hours',
      fraction double precision DEFAULT 1.2345678901234567,
      bytes bytea DEFAULT '\\x00ff'::bytea
    );
    CREATE INDEX entries_state ON entries (state) WHERE active;
    CREATE TABLE ledger (id integer PRIMARY KEY) PARTITION BY RANGE (id);
    CREATE TABLE ledger_first PARTITION OF ledger FOR VALUES FROM (0) TO (10);`,
};

test('schema snapshots are independent of codecs, data, sequence position and generated text', async () => {
  await project(fixture, async (options) => {
    await migrate(options);
    const request = { connection: pool, namespace: options.namespace };
    const original = await inspectSchema(request);
    assert.equal(original.formatVersion, 1);
    assert.match(original.fingerprint, /^tenon-schema-v1:sha256:[a-f0-9]{64}$/);
    assert.deepEqual(
      original.tables.map((table) => table.name),
      ['entries', 'ledger', 'ledger_first'],
    );
    assert.deepEqual(original.enums, [{ name: 'state', labels: ['queued', 'done'] }]);
    assert.equal(original.domains[0]!.name, 'positive');
    assert.equal(original.sequences[0]!.start, '9007199254740993');
    assert.deepEqual(original.sequences[0]!.ownedBy, {
      schema: options.namespace,
      table: 'entries',
      column: 'id',
    });
    assert.ok(original.tables.find((table) => table.name === 'ledger')!.partitionKey);
    assert.ok(original.tables.find((table) => table.name === 'ledger_first')!.partitionBound);
    await pool.queryClassic(
      `INSERT INTO ${qualified(options.namespace, 'entries')} (value) VALUES (1)`,
    );
    assert.deepEqual(await inspectSchema(request), original);
    // Function bodies and security policy remain independently verified application contracts.
    await pool.queryClassic(`CREATE OR REPLACE FUNCTION ${qualified(options.namespace, 'flag')}()
      RETURNS boolean LANGUAGE sql AS 'SELECT false'`);
    await pool.queryClassic(`GRANT SELECT ON ${qualified(options.namespace, 'entries')} TO PUBLIC`);
    await pool.queryClassic(
      `ALTER TABLE ${qualified(options.namespace, 'entries')} ENABLE ROW LEVEL SECURITY`,
    );
    assert.deepEqual(await inspectSchema(request), original);
    const configured = createPool({
      connectionString: testConnection,
      maxConnections: 1,
      startupParameters: {
        search_path: `${quote(options.namespace)},pg_catalog`,
        quote_all_identifiers: 'off',
        standard_conforming_strings: 'off',
        bytea_output: 'escape',
        extra_float_digits: '0',
        lc_monetary: 'C',
      },
      codecs: defaultCodecs.with(builtin.timestamptzDate).with({
        oid: 3802,
        text: {
          encode: JSON.stringify,
          decode: () => {
            throw new Error('Catalog reads must use default codecs.');
          },
        },
      }),
    });
    try {
      await configured.queryClassic(`SELECT pg_catalog.set_config(name, value, false) FROM (VALUES
        ('TimeZone', 'Pacific/Chatham'), ('DateStyle', 'SQL, DMY'), ('IntervalStyle', 'iso_8601')
      ) AS settings(name, value)`);
      const settings = `SELECT current_setting('search_path') AS path,
        current_setting('quote_all_identifiers') AS quoted,
        current_setting('standard_conforming_strings') AS strings,
        current_setting('TimeZone') AS zone, current_setting('DateStyle') AS dates,
        current_setting('IntervalStyle') AS intervals, current_setting('bytea_output') AS bytes,
        current_setting('extra_float_digits') AS floats, current_setting('lc_monetary') AS money`;
      const before = (await configured.queryClassic(settings)).rows;
      assert.deepEqual(await inspectSchema({ ...request, connection: configured }), original);
      assert.deepEqual((await configured.queryClassic(settings)).rows, before);
      assert.equal(configured.stats.leased, 0);
    } finally {
      await configured.close();
    }
  });
});

test('schema fingerprints reproduce after fresh replay with different catalog OIDs', async () => {
  await project(fixture, async (options) => {
    await migrate(options);
    const request = { connection: pool, namespace: options.namespace };
    const first = await inspectSchema(request);
    const oid = async () =>
      (
        await pool.queryClassic<{ oid: number }>('SELECT $1::regclass::oid AS oid', [
          qualified(options.namespace, 'entries'),
        ])
      ).rows[0]!.oid;
    const before = await oid();
    await pool.queryClassic(`DROP SCHEMA ${quote(options.namespace)} CASCADE`);
    await migrate(options);
    assert.notEqual(await oid(), before);
    assert.deepEqual(await inspectSchema(request), first);
  });
});

test('declared relation, type, sequence and partition changes alter the versioned fingerprint', async () => {
  await project(fixture, async (options) => {
    await migrate(options);
    const request = { connection: pool, namespace: options.namespace };
    const entries = qualified(options.namespace, 'entries');
    let previous = await inspectSchema(request);
    for (const statement of [
      `ALTER TABLE ${entries} ALTER COLUMN active SET DEFAULT false`,
      `ALTER TABLE ${entries} ALTER COLUMN at SET NOT NULL`,
      `ALTER TABLE ${entries} ADD CONSTRAINT positive_id CHECK (id > 0) NOT VALID`,
      `CREATE INDEX entries_value ON ${entries} (value)`,
      `ALTER TYPE ${qualified(options.namespace, 'state')} ADD VALUE 'cancelled'`,
      `ALTER DOMAIN ${qualified(options.namespace, 'positive')} ADD CONSTRAINT small CHECK (VALUE < 100)`,
      `ALTER SEQUENCE ${qualified(options.namespace, 'entries_id_seq')} INCREMENT BY 2`,
      `ALTER TABLE ${qualified(options.namespace, 'ledger')} DETACH PARTITION ${qualified(options.namespace, 'ledger_first')}`,
      `ALTER TABLE ${entries} ALTER COLUMN value TYPE bigint`,
    ]) {
      await pool.queryClassic(statement);
      const current = await inspectSchema(request);
      assert.notEqual(current.fingerprint, previous.fingerprint, statement);
      previous = current;
    }
  });
});

test('schema CLI uses selected config and namespace, and rejects invalid scope without changing data', async () => {
  await project(fixture, async (options) => {
    await migrate(options);
    const config = await writeConfig(options.directory, {
      connection: testConnection,
      migrations: { namespace: options.namespace },
    });
    const { stdout } = await run(process.execPath, [
      resolve('dist/cli.js'),
      'schema',
      '--config',
      config,
    ]);
    assert.deepEqual(
      JSON.parse(stdout),
      await inspectSchema({ connection: pool, namespace: options.namespace }),
    );
    const overridden = await run(process.execPath, [
      resolve('dist/cli.js'),
      'schema',
      '--config',
      config,
      '--namespace',
      'public',
    ]);
    assert.equal(JSON.parse(overridden.stdout).namespace, 'public');
    await assert.rejects(
      inspectSchema({ connection: pool, namespace: 'missing_schema_snapshot_fixture' }),
      /does not exist/,
    );
    await assert.rejects(
      inspectSchema({ connection: pool, extra: true } as never),
      /Unknown schema option/,
    );
    await assert.rejects(
      run(process.execPath, [
        resolve('dist/cli.js'),
        'schema',
        '--config',
        config,
        '--out',
        join(options.directory, 'bad.json'),
      ]),
    );
    assert.equal(
      (await pool.queryClassic(`SELECT count(*) FROM ${qualified(options.namespace, 'entries')}`))
        .rows[0]!.count,
      '0',
    );
  });
});
