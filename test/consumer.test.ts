import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Pool } from 'pg';

import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const run = promisify(execFile);

test('the packed package preserves API contracts and consumes generated .d.ts schemas under TypeScript 6 and 7', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'tenon-consumer-'));
  const pool = new Pool({ connectionString: testConnection });
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
      'package.json',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/cli.js',
      'docs/agent-guide.md',
      'docs/adoption-guide.md',
      'docs/human-guide.md',
      'docs/reference.md',
    ]) {
      assert.ok(paths.includes(required), `Package is missing ${required}`);
    }
    for (const path of paths) {
      assert.ok(
        ['LICENSE', 'README.md', 'package.json'].includes(path) ||
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
    const pg = JSON.parse(await readFile(resolve('node_modules/pg/package.json'), 'utf8')) as {
      version: string;
    };
    const pgTypes = JSON.parse(
      await readFile(resolve('node_modules/@types/pg/package.json'), 'utf8'),
    ) as { version: string };
    const minimum = JSON.parse(
      await readFile(resolve('node_modules/typescript/package.json'), 'utf8'),
    ) as { version: string };
    const tooling: Record<string, string> = {};
    for (const name of ['eslint', 'typescript-eslint', '@ts-safeql/eslint-plugin']) {
      const metadata = JSON.parse(
        await readFile(resolve('node_modules', name, 'package.json'), 'utf8'),
      ) as { version: string };
      tooling[name] = metadata.version;
    }
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        name: 'tenon-consumer-check',
        private: true,
        type: 'module',
        dependencies: { '@kequtech/tenon-orm': `file:${join(temporary, tarball)}`, pg: pg.version },
        devDependencies: {
          typescript: minimum.version,
          '@types/node': nodeTypes.version,
          '@types/pg': pgTypes.version,
          ...tooling,
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
    const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as {
      name: string;
      license: string;
    };
    assert.equal(metadata.name, '@kequtech/tenon-orm');
    assert.equal(metadata.license, 'ISC');
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
    await writeFile(
      join(consumer, 'safeql-config.ts'),
      `
      import { ESLint } from 'eslint';
      import { defineConfig } from 'eslint/config';
      import safeql from '@ts-safeql/eslint-plugin/config';
      import { safeqlPlugin, eslintPlugin } from '@kequtech/tenon-orm/safeql';
      // The descriptor fits SafeQL's public configuration, and the rule fits ESLint's.
      safeql.configs.connections({
        databaseUrl: 'postgresql://unused',
        plugins: [safeqlPlugin],
        targets: [{ tag: 'sql' }],
        overrides: { types: { numeric: 'string' } },
      });
      new ESLint({ overrideConfig: defineConfig({
        plugins: { tenon: eslintPlugin },
        rules: { 'tenon/check-composition': 'error' },
      }) });
    `,
    );
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
        files: ['type-contracts.ts', 'copies.ts', 'safeql-config.ts', 'checked.ts'],
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
      const row = await db.query(sql\`SELECT 1 AS id WHERE \${predicate}\`, { returns: 'one' });
      const id: number = row.id;
      const user = await db.query(sql<User>\`SELECT * FROM "${options.namespace}"."User"\`, { returns: 'one' });
      const projection = sql<Pick<User, 'id' | 'email'>>\`SELECT id,email FROM "${options.namespace}"."User"\`;
      type UserRow = Rows['User'];
      const indexed = sql<UserRow>\`SELECT * FROM "${options.namespace}"."User"\`;
      const nickname: string | null = user.nickname;
      const created: Date | number = user.createdAt;
      const balance: string = user.balance;
      const input: Rows.Insert['User'] = { id: 1, email: 'reader@example.test', createdAt: new Date(),
        balance: 1.5, settings: JSON.stringify({ enabled: true }) };
      const patch: Rows.Update['User'] = { email: undefined, nickname: null };
      sql.insertValues(input, ['id', 'email', 'createdAt', 'balance', 'settings']);
      sql.assignments(patch, ['email', 'nickname']);
      // @ts-expect-error generated insert inputs require nonnullable fields without defaults
      const missingInput: Rows.Insert['User'] = { id: 1 };
      // @ts-expect-error write types use serialized JSON, preserving SQL nullability
      const invalidPatch: Rows.Update['User'] = { settings: null };
      // @ts-expect-error JSON remains unknown even when imported through a generated type
      user.settings.anything;
    `,
        );
        await writeFile(
          join(consumer, 'eslint.config.mjs'),
          `
      import { defineConfig } from 'eslint/config';
      import safeql from '@ts-safeql/eslint-plugin/config';
      import tseslint from 'typescript-eslint';
      import { safeqlPlugin, eslintPlugin } from '@kequtech/tenon-orm/safeql';
      export default defineConfig({
        files: ['checked.ts'],
        languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true } },
        plugins: { tenon: eslintPlugin },
        rules: { 'tenon/check-composition': 'error' },
        extends: [safeql.configs.connections({
          databaseUrl: process.env.TENON_TEST_DATABASE_URL,
          keepAlive: false,
          plugins: [safeqlPlugin],
          targets: [{ tag: 'sql' }],
        })],
      });
    `,
        );
        await run(join(consumer, 'node_modules/.bin/eslint'), ['checked.ts', '--fix'], {
          cwd: consumer,
          env: { ...process.env, TENON_TEST_DATABASE_URL: testConnection },
        });
        await run(join(consumer, 'node_modules/.bin/eslint'), ['checked.ts'], {
          cwd: consumer,
          env: { ...process.env, TENON_TEST_DATABASE_URL: testConnection },
        });
        const checkedSource = await readFile(join(consumer, 'checked.ts'), 'utf8');
        assert.ok(checkedSource.includes('sql<User>'), 'Valid imported types must survive autofix');
        assert.ok(checkedSource.includes("sql<Pick<User, 'id' | 'email'>>"));
        assert.ok(checkedSource.includes('sql<UserRow>'));
        const assertInvalidAnnotations = async (expectedCount: number) => {
          await assert.rejects(
            run(join(consumer, 'node_modules/.bin/eslint'), ['checked.ts', '--format', 'json'], {
              cwd: consumer,
              env: { ...process.env, TENON_TEST_DATABASE_URL: testConnection },
            }),
            (error: unknown) => {
              const result = error as { stdout: string };
              const [file] = JSON.parse(result.stdout) as {
                messages: { ruleId: string; messageId: string }[];
              }[];
              assert.equal(file!.messages.length, expectedCount, result.stdout);
              assert.ok(
                file!.messages.every(
                  (message) =>
                    message.ruleId === '@ts-safeql/check-sql' &&
                    message.messageId === 'incorrectTypeAnnotations',
                ),
              );
              return true;
            },
          );
        };
        await writeFile(
          join(consumer, 'checked.ts'),
          checkedSource +
            `
      const incomplete = sql<User>\`SELECT id FROM "${options.namespace}"."User"\`;
      const nullable = sql<Pick<User, 'id' | 'email'>>\`SELECT id,nickname AS email FROM "${options.namespace}"."User"\`;
      const directIndex = sql<Rows['User']>\`SELECT * FROM "${options.namespace}"."User"\`;
    `,
        );
        await assertInvalidAnnotations(3);
        await writeFile(join(consumer, 'checked.ts'), checkedSource);
        // Both full-row aliases become stale after adding a column; regeneration repairs them.
        await pool.query(
          'ALTER TABLE "' +
            options.namespace +
            '"."User" ADD COLUMN active boolean NOT NULL DEFAULT true',
        );
        await assertInvalidAnnotations(2);
        await generateUser();
        await run(join(consumer, 'node_modules/.bin/eslint'), ['checked.ts'], {
          cwd: consumer,
          env: { ...process.env, TENON_TEST_DATABASE_URL: testConnection },
        });
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
    // Start without the development dependency graph: npm can retain installed
    // optional peers during prune even when they are unnecessary at runtime.
    const production = join(temporary, 'production');
    await mkdir(production);
    await writeFile(
      join(production, 'package.json'),
      JSON.stringify({
        name: 'tenon-production-check',
        private: true,
        type: 'module',
        dependencies: { '@kequtech/tenon-orm': `file:${join(temporary, tarball)}`, pg: pg.version },
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
    for (const name of [
      '@types/pg',
      '@ts-safeql/eslint-plugin',
      'eslint',
      'typescript-eslint',
      'typescript',
    ]) {
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
      import { Pool } from 'pg';
      import { createTenon, sql } from '@kequtech/tenon-orm';
      import * as second from './second-tenon/index.js';
      const composed = sql\`SELECT \${second.sql.fragment\`\${7}::int\`} AS id\`;
      assert.equal(composed.text, 'SELECT $1::int AS id');
      assert.deepEqual(composed.values, [7]);
      const db = createTenon({ connection: 'postgresql://unused' });
      await db.close();
      const pool = new Pool({ connectionString: 'postgresql://unused' });
      const shared = createTenon({ connection: pool });
      await shared.close();
      assert.equal(pool.ended, false);
      await pool.end();
    `,
      ],
      { cwd: production },
    );
  } finally {
    await pool.end();
    await rm(temporary, { recursive: true, force: true });
  }
});
