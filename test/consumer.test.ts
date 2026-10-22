import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('the packed package preserves API contracts under the minimum and development TypeScript compilers', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'tenon-consumer-'));
  try {
    const packed = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]);
    const manifest = (JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[])[0]!;
    const tarball = manifest.filename;
    const paths = manifest.files.map(file => file.path);
    for (const required of ['LICENSE', 'README.md', 'package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/cli.js']) {
      assert.ok(paths.includes(required), `Package is missing ${required}`);
    }
    for (const path of paths) {
      assert.ok(['LICENSE', 'README.md', 'package.json'].includes(path) || /^dist\/[\w-]+\.(?:js|d\.ts)$/.test(path),
        `Unexpected package content: ${path}`);
    }
    const consumer = join(temporary, 'consumer');
    await mkdir(consumer);
    const nodeTypes = JSON.parse(await readFile(resolve('node_modules/@types/node/package.json'), 'utf8')) as { version: string };
    const pg = JSON.parse(await readFile(resolve('node_modules/pg/package.json'), 'utf8')) as { version: string };
    const pgTypes = JSON.parse(await readFile(resolve('node_modules/@types/pg/package.json'), 'utf8')) as { version: string };
    const minimum = JSON.parse(await readFile(resolve('node_modules/typescript-minimum/package.json'), 'utf8')) as { version: string };
    await writeFile(join(consumer, 'package.json'), JSON.stringify({
      name: 'tenon-consumer-check', private: true, type: 'module',
      dependencies: { '@kequtech/tenon-orm': `file:${join(temporary, tarball)}`, pg: pg.version },
      devDependencies: { typescript: minimum.version, '@types/node': nodeTypes.version, '@types/pg': pgTypes.version },
    }));
    // npm ci seeds the cache with these dependencies. No registry access, install
    // scripts or repository sources are available. The application supplies pg
    // and its own development typings, as required by the public declarations.
    await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer });
    const installed = join(consumer, 'node_modules/@kequtech/tenon-orm');
    const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { name: string; license: string };
    assert.equal(metadata.name, '@kequtech/tenon-orm');
    assert.equal(metadata.license, 'ISC');
    assert.equal(await readFile(join(installed, 'LICENSE'), 'utf8'), await readFile(resolve('LICENSE'), 'utf8'));
    assert.ok((await stat(join(installed, 'dist/cli.js'))).mode & 0o111, 'Installed CLI must be executable');
    const help = await run(join(consumer, 'node_modules/.bin/tenon'), ['--help'], { cwd: consumer });
    assert.ok(help.stdout.trim(), 'Installed CLI must run without a database');
    // Reuse the complete positive/negative API contracts, but resolve Tenon through
    // its installed package exports instead of ../src. Generated definitions remain
    // ordinary committed application files, as they would in a real consumer.
    for (const filename of ['types.test.ts', 'operation-fixtures.ts', 'generated-schema.ts']) {
      const source = (await readFile(resolve('test', filename), 'utf8')).replaceAll("'../src/index.js'", "'@kequtech/tenon-orm'");
      await writeFile(join(consumer, filename), source);
    }
    const config = join(consumer, 'tsconfig.json');
    await writeFile(config, JSON.stringify({ compilerOptions: {
      noEmit: true, strict: true, exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true, skipLibCheck: false, target: 'ES2022',
      module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'],
    }, files: ['types.test.ts'] }));
    for (const compiler of [join(consumer, 'node_modules/typescript/bin/tsc'), resolve('node_modules/typescript/bin/tsc')]) {
      try { await run(process.execPath, [compiler, '-p', config], { cwd: consumer }); }
      catch (error) {
        const output = error as Error & { stdout?: string; stderr?: string };
        assert.fail(`Packed consumer failed with ${compiler}:\n${output.stdout ?? ''}${output.stderr ?? ''}`);
      }
    }
    // Production JavaScript needs only the application-owned driver. Tenon's
    // typings must not turn the application's development typings into runtime
    // dependencies through a peer declaration.
    await run('npm', ['prune', '--omit=dev', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer });
    await assert.rejects(access(join(consumer, 'node_modules/@types/pg')), { code: 'ENOENT' });
    await run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { Pool } from 'pg';
      import { createTenon, define } from '@kequtech/tenon-orm';
      const db = createTenon({ connection: 'postgresql://unused', operations: { noop: define('SELECT 1') } });
      await db.close();
      const pool = new Pool({ connectionString: 'postgresql://unused' });
      const shared = createTenon({ connection: pool });
      await shared.close();
      assert.equal(pool.ended, false);
      await pool.end();
    `], { cwd: consumer });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
