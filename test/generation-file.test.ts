import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool } from '@kequtech/pgclear';
import { Temporal } from '@js-temporal/polyfill';
import {
  createTenon,
  createTemporalCodecs,
  defaultCodecs,
  generateDefinitions,
  identifier,
  migrate,
  sql,
  type GenerateTypesOptions,
} from '../src/index.js';
import { qualified } from '../src/sql.js';
import { recordMigrations } from './fixtures/record-migrations.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';
import { checkGeneratedTypes, typeAssertions } from './helpers/generation.js';

const pool = createPool({ connectionString: testConnection });
const project = migrationProject(pool);
before(() => assertTestDatabase(pool));
after(() => pool.close());

test('database generation writes exact definitions and checks freshness without changing files', async () => {
  await project(recordMigrations, async (options) => {
    await migrate(options);
    const db = createTenon({ connection: pool });
    const out = join(options.directory, 'generated', 'definitions.d.ts');
    const generation = { namespace: options.namespace, out };
    try {
      await assert.rejects(db.generateTypes({ ...generation, check: true }), /file is missing/);
      await assert.rejects(stat(join(options.directory, 'generated')), { code: 'ENOENT' });
      assert.equal(await db.generateTypes(generation), undefined);
      const first = await readFile(out, 'utf8');
      assert.equal(first, await generateDefinitions(options));
      const saved = await stat(out);
      await db.generateTypes({ ...generation, check: true });
      assert.equal((await stat(out)).mtimeMs, saved.mtimeMs);
      await pool.queryClassic(
        `ALTER TABLE ${qualified(options.namespace, 'Record')} ALTER COLUMN name SET DEFAULT 'draft'`,
      );
      await assert.rejects(db.generateTypes({ ...generation, check: true }), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Generated definitions differ:/);
        assert.match(error.message, /Diff excerpt from line/);
        assert.match(error.message, /^- .*"name" text NOT NULL$/m);
        assert.match(error.message, /^\+ .*"name" text NOT NULL DEFAULT 'draft'::text$/m);
        return true;
      });
      assert.equal(await readFile(out, 'utf8'), first);
      await db.generateTypes(generation);
      const updated = await readFile(out, 'utf8');
      assert.notEqual(updated, first);
      await writeFile(
        join(options.directory, '0002_column.up.sql'),
        'ALTER TABLE "Record" ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT false;',
      );
      // A pending migration does not change the connected schema's declarations.
      await db.generateTypes({ ...generation, check: true });
      await migrate(options);
      await assert.rejects(db.generateTypes({ ...generation, check: true }), /definitions differ/);
      assert.equal(await readFile(out, 'utf8'), updated);
      await db.generateTypes(generation);
      const latest = await readFile(out, 'utf8');
      for (const check of [false, true]) {
        await assert.rejects(
          db.generateTypes({ ...generation, namespace: `${options.namespace}_missing`, check }),
          /does not exist/,
        );
      }
      assert.equal(await readFile(out, 'utf8'), latest);
      assert.deepEqual(await readdir(join(options.directory, 'generated')), ['definitions.d.ts']);
    } finally {
      await db.close();
    }
    await assert.rejects(db.generateTypes(generation), /database instance is closed/);
    assert.equal((await pool.queryClassic('SELECT 1 AS value')).rows[0]!.value, 1);
  });
});

test('generation preserves filesystem failures and cleans temporary files after a failed rename', async () => {
  await project(recordMigrations, async (options) => {
    await migrate(options);
    const db = createTenon({ connection: pool });
    const out = join(options.directory, 'existing-directory');
    await mkdir(out);
    await writeFile(join(out, 'retained'), 'original');
    const before = await readdir(options.directory);
    try {
      await assert.rejects(db.generateTypes({ namespace: options.namespace, out, check: true }), {
        code: 'EISDIR',
      });
      await assert.rejects(db.generateTypes({ namespace: options.namespace, out }));
      assert.equal(await readFile(join(out, 'retained'), 'utf8'), 'original');
      assert.deepEqual(await readdir(options.directory), before);
    } finally {
      await db.close();
    }
  });
});

test('database generation rejects invalid options before acquiring a connection', async () => {
  const db = createTenon({ connection: 'postgresql://unused' });
  try {
    for (const options of [
      undefined,
      null,
      [],
      {},
      { out: '' },
      { out: ' ' },
      { out: 'bad\0path' },
      { out: 'schema.ts', check: 'yes' },
      { out: 'schema.ts', namespace: null },
      { out: 'schema.ts', namespace: '' },
      { out: 'schema.ts', onWarning: true },
      { out: 'schema.ts', connection: testConnection },
      { out: 'schema.ts', codecs: defaultCodecs },
    ]) {
      await assert.rejects(db.generateTypes(options as GenerateTypesOptions), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Generation|generation|Identifiers|onWarning/);
        return true;
      });
      assert.equal(db.native.stats.total, 0);
    }
  } finally {
    await db.close();
  }
});

test('generated files follow an owned database Temporal registry and runtime values', async () => {
  await project(
    { '0001_temporal.up.sql': 'CREATE TABLE "Events" (at timestamptz NOT NULL);' },
    async (options) => {
      await migrate(options);
      const codecs = defaultCodecs.with(
        createTemporalCodecs(Temporal, {
          typescriptNamespace: 'import("@js-temporal/polyfill").Temporal',
        }).timestamptz,
      );
      const db = createTenon({
        connection: { connectionString: testConnection, codecs, maxConnections: 1 },
      });
      const out = join(options.directory, 'definitions.ts');
      try {
        await db.generateTypes({ namespace: options.namespace, out });
        // Compile the method's actual output through the shared-pool path as well.
        await checkGeneratedTypes(
          { ...options, connection: db.native },
          `import type { Database } from './definitions.js';
          ${typeAssertions}
          type At = Assert<Equal<Database['Events']['row']['at'], import('@js-temporal/polyfill').Temporal.Instant>>;`,
        );
        const at = Temporal.Instant.from('2026-10-30T12:34:56.123456Z');
        const row = await db.query(
          sql<{
            at: Temporal.Instant;
          }>`INSERT INTO ${identifier(options.namespace, 'Events')} VALUES (${at}) RETURNING at`,
          { returns: 'one' },
        );
        assert.ok(row.at instanceof Temporal.Instant);
        assert.equal(row.at.toString(), at.toString());
        await db.generateTypes({ namespace: options.namespace, out, check: true });
      } finally {
        await db.close();
      }
      await assert.rejects(db.native.queryClassic('SELECT 1'), { code: 'PGCLEAR_CLOSED' });
    },
  );
});
