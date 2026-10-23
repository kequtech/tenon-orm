import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { testConnection } from './helpers/database.js';

const run = promisify(execFile);

test('the packed package preserves API contracts under TypeScript 6 and 7', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'tenon-consumer-'));
  try {
    const packed = await run('npm', [
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      temporary,
    ]);
    const manifest = (
      JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[]
    )[0]!;
    const tarball = manifest.filename;
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
    // npm ci seeds the cache with these dependencies. No registry access, install
    // scripts or repository sources are available. The application supplies pg
    // and its own development typings, as required by the public declarations.
    await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: consumer,
    });
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
      import { tenonSafeql } from '@kequtech/tenon-orm/safeql';
      const config = tenonSafeql({ databaseUrl: 'postgresql://unused', overrides: { types: { numeric: 'string' } } });
      // @ts-expect-error a database address must be supplied explicitly
      tenonSafeql({});
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
    await writeFile(
      join(consumer, 'checked.ts'),
      `
      import { sql, type Database } from '@kequtech/tenon-orm';
      declare const db: Database;
      const predicate = sql.fragment\`1 = \${1}\`;
      const row = await db.query(sql\`SELECT 1 AS id WHERE \${predicate}\`, { returns: 'one' });
      const id: number = row.id;
    `,
    );
    await writeFile(
      join(consumer, 'eslint.config.mjs'),
      `
      import { tenonSafeql } from '@kequtech/tenon-orm/safeql';
      export default tenonSafeql({ databaseUrl: process.env.TENON_TEST_DATABASE_URL, files: ['checked.ts'] });
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
      ['install', '--omit=dev', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: production },
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
    await rm(temporary, { recursive: true, force: true });
  }
});
