import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
test('documentation follows Tenon dependencies in an isolated layout with a different application driver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-docs-'));
  const isolated = join(root, 'isolated/node_modules/@kequtech');
  try {
    const packages = [
      [join(isolated, 'tenon-orm'), '@kequtech/tenon-orm', '0.5.1'],
      [join(isolated, 'pgclear'), '@kequtech/pgclear', '0.3.6'],
      [join(isolated, 'pgclear-jobs'), '@kequtech/pgclear-jobs', '0.3.0'],
      [join(root, 'node_modules/@kequtech/pgclear'), '@kequtech/pgclear', '99.0.0'],
    ] as const;
    for (const [directory, name, version] of packages) {
      await mkdir(join(directory, 'dist'), { recursive: true });
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({ name, version, type: 'module', exports: './dist/index.js' }),
      );
      await writeFile(join(directory, 'dist/index.js'), '');
    }
    const tenon = join(isolated, 'tenon-orm');
    await writeFile(
      join(tenon, 'dist/documentation.js'),
      await readFile(new URL('../src/documentation.js', import.meta.url), 'utf8'),
    );
    await writeFile(
      join(tenon, 'dist/index.js'),
      "export {installedDocumentation} from './documentation.js';",
    );
    await symlink(tenon, join(root, 'node_modules/@kequtech/tenon-orm'), 'dir');
    await writeFile(
      join(root, 'run.mjs'),
      "import {installedDocumentation} from '@kequtech/tenon-orm'; console.log(JSON.stringify(await installedDocumentation()));",
    );
    const output = await run(process.execPath, [join(root, 'run.mjs')]);
    const docs = JSON.parse(output.stdout) as { name: string; version: string; readme: string }[];
    assert.deepEqual(
      docs.map((d) => d.version),
      ['0.5.1', '0.3.6', '0.3.0'],
    );
    assert.ok(docs.every((d) => d.readme.startsWith(isolated)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
