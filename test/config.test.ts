import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { createTenon, migrationStatus } from '../src/index.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';
import { createPool } from '@kequtech/pgclear';

const run = promisify(execFile);
const cli = resolve('dist/cli.js');
const library = pathToFileURL(resolve('dist/index.js')).href;

test('init creates runnable config offline and refuses existing or inherited configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-init-'));
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  try {
    await run(process.execPath, [cli, 'init'], { cwd: directory, env: environment });
    const filename = join(directory, 'tenon.config.ts');
    const original = await readFile(filename, 'utf8');
    // Import and construct the application's database during a credential-free build.
    await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {main as config} from ${JSON.stringify(pathToFileURL(filename).href)};
        import {createTenon} from ${JSON.stringify(library)};
        const db = createTenon(config);
        await db.close();`,
      ],
      { cwd: directory, env: environment },
    );
    await assert.rejects(
      run(process.execPath, [cli, 'init'], { cwd: directory, env: environment }),
    );
    assert.equal(await readFile(filename, 'utf8'), original);
    const nested = join(directory, 'nested');
    await mkdir(nested);
    await assert.rejects(run(process.execPath, [cli, 'init'], { cwd: nested, env: environment }));
    await assert.rejects(readFile(join(nested, 'tenon.config.ts')), { code: 'ENOENT' });
    // Migration creation consumes the generated module without needing any credentials.
    await run(process.execPath, [cli, 'new', 'first'], {
      cwd: nested,
      env: environment,
    });
    assert.equal(await readFile(join(directory, 'migrations/0001_first.up.sql'), 'utf8'), '');
    const custom = join(directory, 'config/custom.mjs');
    await run(process.execPath, [cli, 'init', '--config', custom], {
      cwd: directory,
      env: environment,
    });
    const javascript = await readFile(custom, 'utf8');
    await assert.rejects(
      run(process.execPath, [cli, 'init', '--config', custom], { cwd: directory }),
    );
    assert.equal(await readFile(custom, 'utf8'), javascript);
    await run(process.execPath, [cli, 'new', 'custom', '--config', custom], {
      cwd: directory,
      env: environment,
    });
    assert.equal(
      await readFile(join(directory, 'config/migrations/0001_custom.up.sql'), 'utf8'),
      '',
    );
    await assert.rejects(
      run(process.execPath, [cli, 'status', '--config', custom], {
        cwd: directory,
        env: environment,
      }),
      (error) => {
        assert.match(String((error as { stderr: string }).stderr), /connectionString.*nonempty/);
        return true;
      },
    );
    await assert.rejects(
      run(process.execPath, [cli, 'init', '--config', 'unsupported.json'], { cwd: directory }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('init never imports an existing JavaScript config and blank CLI paths fail before loading it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-init-existing-'));
  try {
    const filename = join(directory, 'tenon.config.mjs');
    const source = 'throw new Error("existing config was executed");';
    await writeFile(filename, source);
    await assert.rejects(run(process.execPath, [cli, 'init'], { cwd: directory }), (error) => {
      assert.match(String((error as { stderr: string }).stderr), /already exists/);
      return true;
    });
    for (const out of ['', ' ']) {
      await assert.rejects(
        run(process.execPath, [cli, 'generate', '--out', out], { cwd: directory }),
        (error) => {
          assert.match(String((error as { stderr: string }).stderr), /nonempty path/);
          return true;
        },
      );
    }
    assert.equal(await readFile(filename, 'utf8'), source);
    await assert.rejects(readFile(join(directory, 'tenon.config.ts')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('configuration loads native TypeScript imports and resolves configured paths from its directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-config-'));
  try {
    await writeFile(
      join(directory, 'connection.ts'),
      `export const connection: string = 'postgresql://unused';`,
    );
    const filename = join(directory, 'settings.mts');
    await writeFile(
      filename,
      `import { connection } from './connection.ts';
      export default { connection, generate: {out: 'generated/schema.d.ts', namespace: 'app'}, check: {project: 'app/tsconfig.json'} };`,
    );
    const config = await loadConfig(filename);
    assert.equal(config.connection, 'postgresql://unused');
    assert.deepEqual(config.generate, {
      out: join(directory, 'generated/schema.d.ts'),
      namespace: 'app',
    });
    assert.equal(config.check?.project, join(directory, 'app/tsconfig.json'));
    const db = createTenon(config);
    await db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('database selection is explicit for multiple exports and never falls back after a selection error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-database-selection-'));
  const filename = join(directory, 'tenon.config.mjs');
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  try {
    await writeFile(
      filename,
      `
      export const main = {connection: undefined, migrations: {directory: 'main'}};
      export const analytics = {connection: undefined, migrations: {directory: 'analytics'}};
      export const helper = 'not a database';
    `,
    );
    await assert.rejects(loadConfig(filename), /Multiple databases.*analytics.*main.*--database/);
    await assert.rejects(loadConfig(filename, 'missing'), /Unknown database.*missing/);
    await assert.rejects(loadConfig(filename, 'helper'), /Unknown database/);
    for (const name of ['', ' ']) await assert.rejects(loadConfig(filename, name), /nonempty/);
    for (const args of [[], ['--database', 'missing'], ['--database', '']]) {
      await assert.rejects(
        run(process.execPath, [cli, 'new', 'first', ...args], {
          cwd: directory,
          env: { ...environment, DATABASE_URL: testConnection },
        }),
      );
    }
    for (const name of ['main', 'analytics']) {
      await assert.rejects(readFile(join(directory, name, '0001_first.up.sql')), {
        code: 'ENOENT',
      });
      await run(process.execPath, [cli, 'new', 'first', '--database', name], {
        cwd: directory,
        env: environment,
      });
      assert.equal(await readFile(join(directory, name, '0001_first.up.sql'), 'utf8'), '');
    }
    const alternate = join(directory, 'alternate.mjs');
    await writeFile(
      alternate,
      `export const other = {connection: undefined, migrations: {directory: 'other'}};`,
    );
    await run(
      process.execPath,
      [cli, 'new', 'first', '--config', alternate, '--database', 'other'],
      {
        cwd: directory,
        env: environment,
      },
    );
    assert.equal(await readFile(join(directory, 'other/0001_first.up.sql'), 'utf8'), '');
    await assert.rejects(
      run(process.execPath, [cli, 'init', '--config', 'must-not-exist.mjs', '--database', 'main'], {
        cwd: directory,
        env: environment,
      }),
    );
    await assert.rejects(readFile(join(directory, 'must-not-exist.mjs')), { code: 'ENOENT' });
    const empty = join(directory, 'empty');
    await mkdir(empty);
    // A selected database must not turn into DATABASE_URL when no config is available.
    await rm(filename);
    await assert.rejects(
      run(process.execPath, [cli, 'new', 'no_fallback', '--database', 'main'], {
        cwd: empty,
        env: { ...environment, DATABASE_URL: testConnection },
      }),
    );
    await assert.rejects(readFile(join(empty, 'migrations/0001_no_fallback.up.sql')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a single named config is selected automatically and unused exports are not validated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-one-database-'));
  try {
    const filename = join(directory, 'single.mjs');
    await writeFile(
      filename,
      `
      export const codecs = {};
      export const helper = () => {};
      export const main = {connection: undefined, migrations: {directory: 'main'}};
    `,
    );
    assert.equal((await loadConfig(filename)).migrations?.directory, join(directory, 'main'));
    const multiple = join(directory, 'multiple.mjs');
    await writeFile(
      multiple,
      `
      export const main = {connection: undefined, migrations: {directory: 'main'}, onQuery() {}};
      export const analytics = {connection: undefined, generate: {out: ''}};
    `,
    );
    const config = await loadConfig(multiple, 'main');
    assert.equal(config.migrations?.directory, join(directory, 'main'));
    assert.equal(typeof config.onQuery, 'function');
    await assert.rejects(loadConfig(multiple, 'analytics'), /Generation out/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid, ambiguous and failing configurations reject without generating or disclosing import errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-config-errors-'));
  try {
    const filename = join(directory, 'tenon.config.mjs');
    for (const source of [
      'export const config = {};',
      'export default null;',
      'export default {connection: ""};',
      'export default {connection: "postgresql://unused", unknown: true};',
      'export default {connection: {acquire() {}, close() {}}};',
      'export default {connection: "postgresql://unused", generate: {out: ""}};',
      'export default {connection: "postgresql://unused", generate: {out: "schema.ts", check: true}};',
      'export default {connection: "postgresql://unused", check: {project: ""}};',
      'export default {connection: "postgresql://unused", check: {readTypes: {invalid: "string"}}};',
      'export default {connection: "postgresql://unused", session: {wrong: "value"}};',
      'export default {connection: "postgresql://unused", session: {role: 123}};',
      'export default {connection: "postgresql://unused", timeouts: {statementMs: 0}};',
      'export default {connection: "postgresql://unused", timeouts: {lockMs: null}};',
      'export default {connection: "postgresql://unused", baseline: {schemas: []}};',
      'export default {connection: "postgresql://unused", baseline: {connection: 123}};',
      'throw new Error("secret_import_failure");',
    ]) {
      await writeFile(filename, source);
      await assert.rejects(
        run(process.execPath, [cli, 'generate', '--out', 'schema.ts'], { cwd: directory }),
        (error) => {
          assert.ok(error instanceof Error && 'stderr' in error);
          assert.ok('code' in error && error.code === 1);
          assert.ok(!String(error.stderr).includes('secret_import_failure'));
          return true;
        },
      );
      await assert.rejects(readFile(join(directory, 'schema.ts')), { code: 'ENOENT' });
    }
    await writeFile(filename, 'export default {connection: "postgresql://unused"};');
    await writeFile(
      join(directory, 'tenon.config.ts'),
      'throw new Error("must not import an ambiguous config");',
    );
    await assert.rejects(run(process.execPath, [cli, 'generate'], { cwd: directory }), (error) => {
      assert.match(String((error as { stderr: string }).stderr), /Multiple Tenon config files/);
      return true;
    });
    // Explicit selection bypasses ambiguity and the unused throwing module.
    await assert.rejects(
      run(process.execPath, [cli, 'generate', '--config', filename], { cwd: directory }),
      (error) => {
        assert.match(String((error as { stderr: string }).stderr), /generate.out/);
        return true;
      },
    );
    await assert.rejects(
      run(process.execPath, [cli, 'generate', '--config', 'missing.mjs'], { cwd: directory }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime, generation, checking and inspection share Temporal codecs and session configuration', async () => {
  const pool = createPool(testConnection);
  try {
    await assertTestDatabase(pool);
    await migrationProject(pool)(
      {
        '0001_events.up.sql':
          'CREATE TABLE "Events" (at timestamptz NOT NULL, total bigint NOT NULL);',
        '0001_events.down.sql': 'DROP TABLE "Events";',
      },
      async (options) => {
        const root = options.directory;
        await writeFile(join(root, 'package.json'), '{"type":"module"}');
        const nested = join(root, 'nested');
        await mkdir(nested);
        const polyfill = pathToFileURL(
          resolve('node_modules/@js-temporal/polyfill/dist/index.esm.js'),
        ).href;
        await writeFile(
          join(root, 'tenon.config.ts'),
          `
        import { defaultCodecs, builtin, createTemporalCodecs } from ${JSON.stringify(library)};
        import { Temporal } from ${JSON.stringify(polyfill)};
        const codecs = defaultCodecs.with(builtin.int8BigInt).with(createTemporalCodecs(Temporal, {
          typescriptNamespace: 'import("@js-temporal/polyfill").Temporal',
        }).timestamptz).with({oid: 25, text: {encode: String, decode: (raw) => ({raw}), typescript: '{raw: string}'}});
        export const main = {
          connection: {
            connectionString: ${JSON.stringify(testConnection)}, maxConnections: 1, codecs,
            startupParameters: {search_path: ${JSON.stringify('"' + options.namespace + '",pg_catalog')}},
          },
          generate: {out: 'generated/schema.d.ts'},
          migrations: {directory: '.', namespace: ${JSON.stringify(options.namespace)}},
          baseline: {connection: ${JSON.stringify(testConnection)}, schemas: [${JSON.stringify(options.namespace)}]},
          check: {project: 'tsconfig.json'},
          session: {timeZone: 'Europe/Budapest'},
          timeouts: {statementMs: 800, lockMs: 100},
        };
        export const analytics = {connection: undefined, generate: {out: ""}};`,
        );
        await writeFile(
          join(root, 'queries.ts'),
          `
        import { sql } from '@kequtech/tenon-orm';
        import type {Database} from './generated/schema.js';
        export const query = sql<Database['Events']['row']>
          \`SELECT at, total FROM "Events"\`;
      `,
        );
        await writeFile(
          join(root, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              skipLibCheck: true,
              types: ['node'],
              typeRoots: [resolve('node_modules/@types')],
              paths: {
                '@kequtech/tenon-orm': [resolve('dist/index.d.ts')],
                '@js-temporal/polyfill': [resolve('node_modules/@js-temporal/polyfill/index.d.ts')],
              },
            },
            files: ['queries.ts'],
          }),
        );
        const commandOptions = {
          cwd: nested,
          env: { ...process.env, DATABASE_URL: 'postgresql://deliberately-unused' },
        };
        const tenon = (...args: string[]) =>
          run(process.execPath, [cli, ...args, '--database', 'main'], commandOptions);
        await tenon('migrate');
        await pool.queryClassic(
          `CREATE FUNCTION \"${options.namespace}\".to_regclass(text) RETURNS regclass LANGUAGE SQL AS 'SELECT NULL::regclass'`,
        );
        const status = await tenon('status');
        assert.deepEqual(JSON.parse(status.stdout), { applied: ['0001'], pending: [] });
        await tenon('generate');
        const out = join(root, 'generated/schema.d.ts');
        const saved = await readFile(out, 'utf8');
        assert.match(saved, /import\("@js-temporal\/polyfill"\).Temporal.Instant/);
        const current = await tenon('generate', '--check');
        assert.match(current.stdout, /current/);
        const checked = await tenon('check', '--json');
        assert.equal((JSON.parse(checked.stdout) as { ok: boolean }).ok, true);
        const queryFile = join(nested, 'query.sql');
        await writeFile(queryFile, 'SELECT at, total FROM "Events"');
        const described = await tenon('describe', queryFile);
        const description = JSON.parse(described.stdout) as {
          columns: { readType: string }[];
          context: { timeZone: string; statementTimeoutMs: number; lockTimeoutMs: number };
        };
        assert.deepEqual(
          description.columns.map((column) => column.readType),
          ['import("@js-temporal/polyfill").Temporal.Instant', 'bigint'],
        );
        assert.equal(description.context.timeZone, 'Europe/Budapest');
        assert.equal(description.context.statementTimeoutMs, 800);
        const override = await tenon(
          'describe',
          queryFile,
          '--time-zone',
          'UTC',
          '--lock-timeout-ms',
          '200',
        );
        const context = (JSON.parse(override.stdout) as typeof description).context;
        assert.equal(context.timeZone, 'UTC');
        assert.equal(context.statementTimeoutMs, 800);
        assert.equal(context.lockTimeoutMs, 200);
        // The same module configures runtime queries, without consulting CLI environment defaults.
        await run(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import assert from 'node:assert/strict';
        import {main as config} from ${JSON.stringify(pathToFileURL(join(root, 'tenon.config.ts')).href)};
        import {createTenon, sql} from ${JSON.stringify(library)};
        const db = createTenon(config);
        try {
          const row = await db.query(sql\`SELECT TIMESTAMPTZ '2026-10-30 12:00:00+00' AS at, 9007199254740993::bigint AS total\`, {returns: 'one'});
          assert.equal(row.at.toString(), '2026-10-30T12:00:00Z');
          assert.equal(row.total, 9007199254740993n);
        } finally { await db.close(); }
      `,
          ],
          commandOptions,
        );
        await tenon('generate', '--out', 'override.d.ts');
        assert.equal(await readFile(join(nested, 'override.d.ts'), 'utf8'), saved);
        await writeFile(out, 'stale');
        await assert.rejects(tenon('generate', '--check'));
        assert.equal(await readFile(out, 'utf8'), 'stale');
        await rm(out);
        await assert.rejects(tenon('generate', '--check'));
        await assert.rejects(readFile(out), { code: 'ENOENT' });
        const loaded = await loadConfig(join(root, 'tenon.config.ts'), 'main');
        const shared = createTenon(loaded);
        try {
          assert.deepEqual(
            await migrationStatus({
              connection: shared.native,
              directory: root,
              namespace: options.namespace,
            }),
            { applied: ['0001'], pending: [] },
          );
        } finally {
          await shared.close();
        }
        await tenon('baseline', 'capture', '--directory', 'capture');
        assert.match(
          await readFile(join(nested, 'capture/0001_baseline.up.sql'), 'utf8'),
          /CREATE TABLE/,
        );
        await tenon('rollback');
        const rolledBack = await tenon('status');
        assert.deepEqual(JSON.parse(rolledBack.stdout), { applied: [], pending: ['0001'] });
        await tenon('new', 'next');
        assert.equal(await readFile(join(root, '0002_next.up.sql'), 'utf8'), '');
        assert.deepEqual(
          await pool.queryClassic('SELECT 1 AS value').then((result) => result.rows),
          [{ value: 1 }],
        );
      },
    );
  } finally {
    await pool.close();
  }
});
