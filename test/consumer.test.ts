import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import postgres from 'postgres';

import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const run = promisify(execFile);

test('the packed package preserves API contracts and consumes generated .d.ts schemas under TypeScript 6 and 7', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'tenon-consumer-'));
  const pool = postgres(testConnection);
  // npm publish --dry-run passes this setting into its lifecycle tests. Exercise
  // that environment while explicitly creating the local pack/install fixtures.
  const npmEnv = { ...process.env, npm_config_dry_run: 'true' };
  try {
    const packed = await run(
      'npm',
      ['pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', temporary],
      { env: npmEnv },
    );
    const manifest = (
      JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[]
    )[0]!;
    const tarball = manifest.filename;
    assert.ok((await stat(join(temporary, tarball))).size > 0, 'npm pack must create a tarball');
    const paths = manifest.files.map((file) => file.path);
    for (const required of [
      'LICENSE',
      'README.md',
      'CHANGELOG.md',
      'package.json',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/cli.js',
      'dist/describe.js',
      'dist/inspection/catalog.js',
      'dist/inspection/connection.js',
      'docs/agent-guide.md',
      'docs/adoption-guide.md',
      'docs/human-guide.md',
      'docs/reference.md',
      'docs/query-inspection.md',
      'docs/mutations.md',
    ]) {
      assert.ok(paths.includes(required), `Package is missing ${required}`);
    }
    for (const path of paths) {
      assert.ok(
        ['LICENSE', 'README.md', 'CHANGELOG.md', 'package.json'].includes(path) ||
          /^docs\/(?:[\w-]+\/)*[\w-]+\.md$/.test(path) ||
          /^dist\/(?:[\w-]+\/)*[\w-]+\.(?:js|d\.ts)$/.test(path),
        `Unexpected package content: ${path}`,
      );
    }
    assert.ok(!paths.includes('CONTRIBUTING.md'));
    const consumer = join(temporary, 'consumer');
    await mkdir(join(consumer, 'fixtures'), { recursive: true });
    const nodeTypes = JSON.parse(
      await readFile(resolve('node_modules/@types/node/package.json'), 'utf8'),
    ) as { version: string };
    const minimum = JSON.parse(
      await readFile(resolve('node_modules/typescript/package.json'), 'utf8'),
    ) as { version: string };
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        name: 'tenon-consumer-check',
        private: true,
        type: 'module',
        dependencies: { '@kequtech/tenon-orm': `file:${join(temporary, tarball)}` },
        devDependencies: {
          typescript: minimum.version,
          '@types/node': nodeTypes.version,
        },
      }),
    );
    // npm ci caches tarballs, but not necessarily the registry metadata needed
    // for a fresh dependency graph. Prefer the cache, fetching anything missing.
    // Install the packed artifact without lifecycle scripts or repository sources.
    await run(
      'npm',
      [
        'install',
        '--dry-run=false',
        '--prefer-offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: consumer, env: npmEnv },
    );
    const installed = join(consumer, 'node_modules/@kequtech/tenon-orm');
    // Relative documentation links must also work for readers of the installed package.
    for (const path of paths.filter((path) => path.endsWith('.md'))) {
      const markdown = await readFile(join(installed, path), 'utf8');
      for (const match of markdown.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
        const target = match[1]!.split('#')[0]!;
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const relative = posix.normalize(
          posix.join(posix.dirname(path), decodeURIComponent(target)),
        );
        assert.ok(paths.includes(relative), `${path} links to missing package file ${target}`);
      }
    }
    const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as {
      name: string;
      license: string;
      dependencies: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    assert.equal(metadata.name, '@kequtech/tenon-orm');
    assert.equal(metadata.license, 'ISC');
    assert.deepEqual(metadata.dependencies, { postgres: '3.4.9' });
    assert.equal(metadata.peerDependencies, undefined);
    assert.equal(
      await readFile(join(installed, 'LICENSE'), 'utf8'),
      await readFile(resolve('LICENSE'), 'utf8'),
    );
    assert.ok(
      (await stat(join(installed, 'dist/cli.js'))).mode & 0o111,
      'Installed CLI must be executable',
    );
    const help = await run(join(consumer, 'node_modules/.bin/tenon'), ['--help'], {
      cwd: consumer,
    });
    assert.ok(help.stdout.trim(), 'Installed CLI must run without a database');
    // Reuse the complete positive/negative API contracts, but resolve Tenon through
    // its installed package exports instead of repository source. Generated definitions remain
    // ordinary committed application files, as they would in a real consumer.
    for (const filename of [
      'type-contracts.ts',
      'fixtures/queries.ts',
      'fixtures/generated-schema.ts',
    ]) {
      const source = (await readFile(resolve('test', filename), 'utf8'))
        .replaceAll("'../src/index.js'", "'@kequtech/tenon-orm'")
        .replaceAll("'../../src/index.js'", "'@kequtech/tenon-orm'");
      await writeFile(join(consumer, filename), source);
    }
    const config = join(consumer, 'tsconfig.json');
    // A data-access package may bring its own copy of Tenon into the application.
    await cp(join(installed, 'dist'), join(consumer, 'second-tenon'), { recursive: true });
    await writeFile(
      join(consumer, 'copies.ts'),
      `
      import { sql, type Database, type QueryClient } from '@kequtech/tenon-orm';
      import * as second from './second-tenon/index.js';
      declare const db: Database;
      declare const other: second.Database;
      type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
      type Assert<T extends true> = T;
      async function check() {
        const fromSecond = (client: second.QueryClient, { id }: { id: number }) => client.query(second.sql<{ id: number }>\`SELECT \${id}::int AS id\`, { returns: 'one' });
        const fromFirst = (client: QueryClient, { id }: { id: number }) => client.query(sql<{ id: number }>\`SELECT \${id}::int AS id\`, { returns: 'one' });
        const a = await fromSecond(db, { id: 1 });
        const b = await fromFirst(other, { id: 1 });
        const c = await db.query(second.sql<{ id: number }>\`SELECT 1 AS id\`, { returns: 'many' });
        const d = await other.query(sql<{ id: number }>\`SELECT 1 AS id\`, { returns: 'oneOrNone' });
        const fragments = sql.join([second.sql.fragment\`TRUE\`], 'AND');
        const reverse = second.sql.join([sql.fragment\`TRUE\`], 'AND');
        const types: [Assert<Equal<typeof a, { id: number }>>, Assert<Equal<typeof b, { id: number }>>,
          Assert<Equal<typeof c, { id: number }[]>>, Assert<Equal<typeof d, { id: number } | undefined>>] = [true, true, true, true];
        // @ts-expect-error crossing package copies preserves the input contract
        await fromSecond(db, { id: 'wrong' });
      }
    `,
    );
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: ['node'],
        },
        files: ['type-contracts.ts', 'copies.ts', 'checked.ts'],
      }),
    );
    await assertTestDatabase(pool);
    await migrationProject(pool)(
      {
        '0001_user.up.sql': `CREATE TABLE "User" (
        id integer PRIMARY KEY, email text NOT NULL, nickname text,
        "createdAt" timestamptz NOT NULL, balance numeric NOT NULL, settings jsonb NOT NULL
      );`,
      },
      async (options) => {
        const cli = join(consumer, 'node_modules/.bin/tenon');
        const commandOptions = {
          cwd: consumer,
          env: { ...process.env, DATABASE_URL: testConnection },
        };
        await run(
          cli,
          ['migrate', '--directory', options.directory, '--namespace', options.namespace],
          commandOptions,
        );
        const generateUser = () =>
          run(
            cli,
            ['generate', '--namespace', options.namespace, '--out', 'generated-user.d.ts'],
            commandOptions,
          );
        await generateUser();
        await access(join(consumer, 'generated-user.d.ts'));
        await assert.rejects(access(join(consumer, 'generated-user.js')), { code: 'ENOENT' });
        await writeFile(
          join(consumer, 'checked.ts'),
          `
      import { sql, type Database } from '@kequtech/tenon-orm';
      import type { User, Rows } from './generated-user.js';
      declare const db: Database;
      const predicate = sql.fragment\`1 = \${1}\`;
      const row = await db.query(sql<{ id: number }>\`SELECT 1 AS id WHERE \${predicate}\`, { returns: 'one' });
      const id: number = row.id;
      const user = await db.query(sql<User>\`SELECT * FROM "${options.namespace}"."User"\`, { returns: 'one' });
      const projection = sql<Pick<User, 'id' | 'email'>>\`SELECT id,email FROM "${options.namespace}"."User"\`;
      type UserRow = Rows['User'];
      const indexed = sql<UserRow>\`SELECT * FROM "${options.namespace}"."User"\`;
      const nickname: string | null = user.nickname;
      const created: Date = user.createdAt;
      const balance: string = user.balance;
      const input: Rows.Insert['User'] = { id: 1, email: 'reader@example.test', createdAt: new Date(),
        balance: 1.5, settings: { enabled: true } };
      const patch: Rows.Update['User'] = { email: undefined, nickname: null };
      sql.insertValues(input, ['id', 'email', 'createdAt', 'balance', 'settings']);
      sql.assignments(patch, ['email', 'nickname']);
      // @ts-expect-error generated insert inputs require nonnullable fields without defaults
      const missingInput: Rows.Insert['User'] = { id: 1 };
      // @ts-expect-error nonnullable JSON columns reject SQL null in generated writes
      const invalidPatch: Rows.Update['User'] = { settings: null };
      // @ts-expect-error JSON remains unknown even when imported through a generated type
      user.settings.anything;
    `,
        );
        for (const compiler of [
          join(consumer, 'node_modules/typescript/bin/tsc'),
          resolve('node_modules/typescript-next/bin/tsc'),
        ]) {
          try {
            await run(process.execPath, [compiler, '-p', config], { cwd: consumer });
          } catch (error) {
            const output = error as Error & { stdout?: string; stderr?: string };
            assert.fail(
              `Packed consumer failed with ${compiler}:\n${output.stdout ?? ''}${output.stderr ?? ''}`,
            );
          }
        }
      },
    );
    await writeFile(
      join(consumer, 'lifecycle.mjs'),
      await readFile(resolve('test/fixtures/lifecycle.mjs'), 'utf8'),
    );
    try {
      await run(process.execPath, ['lifecycle.mjs'], {
        cwd: consumer,
        env: { ...process.env, TENON_TEST_DATABASE_URL: testConnection },
      });
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string };
      assert.fail(`Installed lifecycle failed:
${result.stdout ?? ''}
${result.stderr ?? ''}`);
    }
    // Exercise the published API and CLI in a fresh installation without development tools.
    const production = join(temporary, 'production');
    await mkdir(production);
    await writeFile(
      join(production, 'package.json'),
      JSON.stringify({
        name: 'tenon-production-check',
        private: true,
        type: 'module',
        dependencies: { '@kequtech/tenon-orm': `file:${join(temporary, tarball)}` },
      }),
    );
    await run(
      'npm',
      [
        'install',
        '--dry-run=false',
        '--omit=dev',
        '--prefer-offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: production, env: npmEnv },
    );
    await cp(join(installed, 'dist'), join(production, 'second-tenon'), { recursive: true });
    for (const name of ['pg', '@types/pg', 'typescript']) {
      await assert.rejects(access(join(production, 'node_modules', name)), { code: 'ENOENT' });
    }
    await run(join(production, 'node_modules/.bin/tenon'), ['--help'], { cwd: production });
    await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import postgres from 'postgres';
      const { createTenon, describeQuery, sql } = await import('@kequtech/tenon-orm');
      const second = await import('./second-tenon/index.js');
      const composed = sql\`SELECT \${second.sql.fragment\`\${7}::int\`} AS id\`;
      assert.equal(composed.text, 'SELECT $1::int AS id');
      assert.deepEqual(composed.values, [7]);
      const db = createTenon({ connection: 'postgresql://unused' });
      await db.close();
      const owned = createTenon({ connection: { url: process.env.TENON_TEST_DATABASE_URL, options: { max: 1 } } });
      assert.equal((await owned.native.unsafe('SELECT 42 AS value'))[0].value, 42);
      await owned.close();
      await assert.rejects(owned.native.unsafe('SELECT 1'), {code: 'CONNECTION_ENDED'});
      const pool = postgres(process.env.TENON_TEST_DATABASE_URL);
      const shared = createTenon({ connection: pool });
      assert.equal(shared.native, pool);
      await shared.close();
      assert.equal((await shared.native.unsafe('SELECT 1 AS value'))[0].value, 1);
      await pool.end();
      const description = await describeQuery({
        connection: process.env.TENON_TEST_DATABASE_URL,
        query: sql\`SELECT \${'not-an-integer'}::integer AS id, 9007199254740993::bigint AS size\`,
        session: { searchPath: 'pg_catalog', timeZone: 'UTC' },
      });
      assert.deepEqual(description.columns.map(c => [c.name, c.readType]), [['id','number'],['size','string']]);
      assert.equal(description.context.searchPath, 'pg_catalog');
      assert.ok(description.issues.some(issue => issue.code === 'nullability-unknown'));
      await assert.rejects(describeQuery({connection: process.env.TENON_TEST_DATABASE_URL,
        query: 'SELECT no_such_column FROM pg_catalog.pg_class'}), {code: '42703'});
    `,
      ],
      { cwd: production, env: { ...process.env, TENON_TEST_DATABASE_URL: testConnection } },
    );
    const sqlFile = join(production, 'inspection.sql');
    await writeFile(
      sqlFile,
      'SELECT $1::integer AS id, count(*) AS total FROM pg_catalog.pg_class',
    );
    const described = await run(
      join(production, 'node_modules/.bin/tenon'),
      ['describe', sqlFile, '--search-path', 'pg_catalog'],
      { cwd: production, env: { ...process.env, DATABASE_URL: testConnection } },
    );
    const description = JSON.parse(described.stdout) as {
      columns: { name: string; readType: string }[];
    };
    assert.deepEqual(
      description.columns.map((c) => [c.name, c.readType]),
      [
        ['id', 'number'],
        ['total', 'string'],
      ],
    );
  } finally {
    await pool.end();
    await rm(temporary, { recursive: true, force: true });
  }
});
