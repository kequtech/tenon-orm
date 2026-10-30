import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { builtin, createTenon, defaultCodecs, sql, type TenonConfig } from '../src/index.js';
import { testConnection } from './helpers/database.js';

const run = promisify(execFile);

test('shared configs allow missing credentials until database use and close without initialization', async () => {
  for (const connection of [
    undefined,
    '',
    { connectionString: undefined },
    { connectionString: '' },
  ]) {
    const config = { connection } satisfies TenonConfig;
    const unused = createTenon(config);
    const closing = unused.close();
    assert.equal(unused.close(), closing);
    await closing;
    await assert.rejects(unused.query(sql`SELECT 1`), /closed/);
    assert.throws(() => unused.native, /closed/);

    const queried = createTenon(config);
    await assert.rejects(queried.query(sql`SELECT 1`), /connection.*(required|nonempty)/);
    await queried.close();

    const transacted = createTenon(config);
    await assert.rejects(
      transacted.transaction(async () => assert.fail('must not run without credentials')),
      /connection.*(required|nonempty)/,
    );
    await transacted.close();
  }
});

test('the constructor accepts only a config object and rejects the former wrapper and unknown options', () => {
  for (const value of [null, undefined, testConnection, () => ({}), {}]) {
    assert.throws(() => createTenon(value as never));
  }
  assert.throws(() => createTenon({ config: { connection: testConnection } } as never), /Unknown/);
  assert.throws(
    () => createTenon({ connection: testConnection, unexpected: true } as never),
    /Unknown/,
  );
  assert.throws(
    () => createTenon({ connection: undefined, onQuery: 'invalid' } as never),
    /onQuery/,
  );
});

test('first-use transactions, concurrent queries and native access share configured codecs and one pool', async (t) => {
  const codecs = defaultCodecs.with(builtin.int8BigInt);
  const db = createTenon({
    connection: { connectionString: testConnection, codecs, maxConnections: 1 },
  });
  t.after(() => db.close());
  const result = await db.transaction((tx) =>
    tx.query(sql<{ total: bigint }>`SELECT 42::bigint AS total`, { returns: 'one' }),
  );
  assert.equal(result.total, 42n);
  const rows = await Promise.all(
    Array.from({ length: 4 }, () =>
      db.query(sql`SELECT pg_backend_pid() AS pid, 7::bigint AS total`, { returns: 'one' }),
    ),
  );
  assert.equal(new Set(rows.map((row) => row.pid)).size, 1);
  assert.ok(rows.every((row) => row.total === 7n));
  assert.equal(db.native.codecs, codecs);
  assert.equal(db.native, db.native);
  assert.equal(db.native.stats.total, 1);
  assert.equal((await db.native.queryClassic('SELECT 8::bigint AS total')).rows[0]!.total, 8n);
});

test('named databases share one file and select independent runtime connections, codecs and tooling paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-named-configs-'));
  const library = new URL('../src/index.js', import.meta.url).href;
  const filename = join(directory, 'tenon.config.mjs');
  const databases = [];
  try {
    await writeFile(join(directory, 'query.sql'), 'SELECT 42::bigint AS total');
    await writeFile(
      filename,
      `import {defaultCodecs, builtin} from ${JSON.stringify(library)};
      ${(['main', 'analytics'] as const)
        .map(
          (name) => `export const ${name} = {
        connection: {
          connectionString: ${JSON.stringify(testConnection)},
          applicationName: ${JSON.stringify(name)},
          codecs: ${name === 'analytics' ? 'defaultCodecs.with(builtin.int8BigInt)' : 'defaultCodecs'},
        },
        migrations: {directory: ${JSON.stringify(name + '/migrations')}},
        generate: {out: ${JSON.stringify(name + '/schema.d.ts')}},
      };`,
        )
        .join('\n')}`,
    );
    const exported = (await import(pathToFileURL(filename).href)) as Record<string, TenonConfig>;
    for (const [name, bigint] of [
      ['main', false],
      ['analytics', true],
    ] as const) {
      const config = exported[name]!;
      const db = createTenon(config);
      databases.push(db);
      assert.deepEqual(
        await db.query(
          sql`SELECT current_setting('application_name') AS name, 42::bigint AS total`,
          { returns: 'one' },
        ),
        { name, total: bigint ? 42n : '42' },
      );
      const tooling = await loadConfig(filename, name);
      assert.equal(tooling.migrations?.directory, join(directory, name, 'migrations'));
      assert.equal(tooling.generate?.out, join(directory, name, 'schema.d.ts'));
      const described = await run(
        process.execPath,
        [resolve('dist/cli.js'), 'describe', 'query.sql', '--database', name],
        { cwd: directory, env: { ...process.env, DATABASE_URL: 'postgresql://unused' } },
      );
      const report = JSON.parse(described.stdout) as { columns: { readType: string }[] };
      assert.equal(report.columns[0]!.readType, bigint ? 'bigint' : 'string');
      const cliDatabase = createTenon(tooling);
      databases.push(cliDatabase);
      assert.deepEqual(
        await cliDatabase.query(sql`SELECT 42::bigint AS total`, { returns: 'one' }),
        { total: bigint ? 42n : '42' },
      );
    }
    const pids = await Promise.all(
      [databases[0]!, databases[2]!].map((db) =>
        db.query(sql`SELECT pg_backend_pid() AS pid`, { returns: 'one' }),
      ),
    );
    assert.notEqual(pids[0]!.pid, pids[1]!.pid);
    await databases[0]!.close();
    assert.deepEqual(await databases[2]!.query(sql`SELECT 1 AS value`, { returns: 'one' }), {
      value: 1,
    });
  } finally {
    await Promise.all(databases.map((db) => db.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
