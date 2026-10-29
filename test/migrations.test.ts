import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool, type Pool } from '@kequtech/pgclear';
import {
  createTenon,
  generateDefinitions,
  identifier,
  migrate,
  migrationStatus,
  rollback,
  sql,
} from '../src/index.js';
import { withMigrationLock } from '../src/migrations/connection.js';
import { qualified } from '../src/sql.js';
import { recordMigrations } from './fixtures/record-migrations.js';
import {
  assertTestDatabase,
  testConnection as connection,
  migrationProject,
} from './helpers/database.js';
const pool = createPool({ connectionString: connection });
const project = migrationProject(pool);
before(() => assertTestDatabase(pool));
after(() => pool.close());

async function waitForAdvisoryWaiters(application: string, expected: number): Promise<void> {
  const deadline = Date.now() + 5000;
  let count = 0;
  do {
    const result = (
      await pool.queryClassic<{ count: number }>(
        `
      SELECT count(*)::int AS count FROM pg_catalog.pg_locks l
      JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND NOT l.granted
        AND a.datname = current_database() AND a.application_name = $1`,
        [application],
      )
    ).rows;
    count = result[0]!.count;
    if (count === expected) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Expected ${expected} waiting advisory locks, observed ${count}.`);
}

test('migration upgrades and rollbacks preserve existing data', async () => {
  await project(recordMigrations, async (options) => {
    await migrate(options);
    await pool.queryClassic(
      `INSERT INTO ${qualified(options.namespace, 'Record')} (name) VALUES ('existing')`,
      [],
    );
    await writeFile(
      join(options.directory, '0002_enabled.up.sql'),
      'ALTER TABLE "Record" ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT true;',
    );
    await writeFile(
      join(options.directory, '0002_enabled.down.sql'),
      'ALTER TABLE "Record" DROP COLUMN enabled;',
    );
    const db = createTenon({ connection: pool });
    const target = qualified(options.namespace, 'Record');
    try {
      assert.deepEqual(
        await db.query(sql`SELECT * FROM ${identifier(options.namespace, 'Record')} ORDER BY id`, {
          returns: 'many',
        }),
        [{ id: 1, name: 'existing' }],
      );
      assert.deepEqual(await migrationStatus(options), { applied: ['0001'], pending: ['0002'] });
      await migrate(options);
      assert.equal(
        (
          await db.query(
            sql`INSERT INTO ${identifier(options.namespace, 'Record')} (name) VALUES (${'new'})`,
            {
              returns: 'native',
            },
          )
        ).rowCount,
        1,
      );
      assert.deepEqual(
        await db.query(sql`SELECT * FROM ${identifier(options.namespace, 'Record')} ORDER BY id`, {
          returns: 'many',
        }),
        [
          { id: 1, name: 'existing', enabled: true },
          { id: 2, name: 'new', enabled: true },
        ],
      );
      assert.deepEqual(await rollback(options), ['0002']);
      assert.deepEqual(
        await db.query(sql`SELECT * FROM ${identifier(options.namespace, 'Record')} ORDER BY id`, {
          returns: 'many',
        }),
        [
          { id: 1, name: 'existing' },
          { id: 2, name: 'new' },
        ],
      );
      assert.equal(
        (
          await db.query(
            sql`INSERT INTO ${identifier(options.namespace, 'Record')} (name) VALUES (${'after rollback'})`,
            {
              returns: 'native',
            },
          )
        ).rowCount,
        1,
      );
      assert.deepEqual(
        await db.query(
          sql`SELECT * FROM ${identifier(options.namespace, 'Record')} WHERE id = ${3}`,
          { returns: 'oneOrNone' },
        ),
        { id: 3, name: 'after rollback' },
      );
    } finally {
      await db.close();
    }
    assert.deepEqual(await migrate(options), ['0002']);
    assert.deepEqual(await rollback({ ...options, steps: 2 }), ['0002', '0001']);
    assert.equal(
      (
        await pool.queryClassic('SELECT to_regclass($1)::text AS name', [
          qualified(options.namespace, 'Record'),
        ])
      ).rows[0]!.name,
      null,
    );
  });
});

test('a failed migration rolls back its schema and data changes without recording success', async () => {
  await project(
    {
      ...recordMigrations,
      '0002_failure.up.sql':
        'INSERT INTO "Record" (name) VALUES (\'rollback\'); CREATE TABLE "Temporary" (id INTEGER); SELECT 1 / 0;',
    },
    async (options) => {
      await assert.rejects(migrate(options), /0002_failure.*failed/);
      assert.deepEqual(await migrationStatus(options), { applied: ['0001'], pending: ['0002'] });
      assert.deepEqual(
        [
          ...(
            await pool.queryClassic(`SELECT * FROM ${qualified(options.namespace, 'Record')}`, [])
          ).rows,
        ],
        [],
      );
      assert.equal(
        (
          await pool.queryClassic('SELECT to_regclass($1)::text AS name', [
            qualified(options.namespace, 'Temporary'),
          ])
        ).rows[0]!.name,
        null,
      );
    },
  );
});

test('edited or missing applied files and out-of-order additions stop migration changes', async () => {
  await project(recordMigrations, async (options) => {
    await migrate(options);
    const up = join(options.directory, '0001_records.up.sql');
    await writeFile(up, recordMigrations['0001_records.up.sql'] + '\n-- changed after deployment');
    await assert.rejects(migrate(options), /history differs/);
    await assert.rejects(rollback(options), /history differs/);
    await writeFile(up, recordMigrations['0001_records.up.sql']);
    await writeFile(join(options.directory, '0000_earlier.up.sql'), 'SELECT 1;');
    await assert.rejects(migrate(options), /history differs/);
    await rm(join(options.directory, '0000_earlier.up.sql'));
    await rm(up);
    await rm(join(options.directory, '0001_records.down.sql'));
    await assert.rejects(migrate(options), /history differs/);
    assert.equal(
      (
        await pool.queryClassic(
          `SELECT count(*)::int AS count FROM ${qualified(options.namespace, '__tenon_migrations')}`,
          [],
        )
      ).rows[0]!.count,
      1,
    );
  });
});

test('migration parsing stays consistent when the connection uses backslash escapes', async () => {
  const configured = createPool({
    connectionString: connection.replace(/([?&])options=[^&]*/, '$1'),
    maxConnections: 1,
    startupParameters: { standard_conforming_strings: 'off' },
  });
  try {
    await project(
      {
        '0001_escape.up.sql': String.raw`CREATE TABLE escaped_commit (id integer);
        SELECT 'a\' b'; COMMIT; -- '
        SELECT nonexistent_column;`,
      },
      async (options) => {
        const migration = { ...options, connection: configured };
        await assert.rejects(migrate(migration));
        assert.equal(
          (
            await pool.queryClassic('SELECT to_regclass($1) AS name', [
              qualified(options.namespace, 'escaped_commit'),
            ])
          ).rows[0]!.name,
          null,
        );
        assert.deepEqual(await migrationStatus(migration), { applied: [], pending: ['0001'] });
        assert.equal(
          (await configured.queryClassic('SHOW standard_conforming_strings', [])).rows[0]!
            .standard_conforming_strings,
          'off',
        );
        // Explicit escape strings remain supported under the normalized setting.
        await writeFile(
          join(options.directory, '0001_escape.up.sql'),
          String.raw`CREATE TABLE escaped_commit (value text); INSERT INTO escaped_commit VALUES (E'a\' b');`,
        );
        await migrate(migration);
        assert.deepEqual(
          [
            ...(
              await pool.queryClassic(
                `SELECT value FROM ${qualified(options.namespace, 'escaped_commit')}`,
                [],
              )
            ).rows,
          ],
          [{ value: "a' b" }],
        );
        assert.equal(
          (await configured.queryClassic('SHOW standard_conforming_strings', [])).rows[0]!
            .standard_conforming_strings,
          'off',
        );
      },
    );
  } finally {
    await configured.close();
  }
});

test('irreversible migrations reject rollback before any selected down operation runs', async () => {
  await project(
    {
      '0001_records.up.sql': recordMigrations['0001_records.up.sql'],
      '0002_column.up.sql': 'ALTER TABLE "Record" ADD COLUMN value INTEGER;',
      '0002_column.down.sql': 'ALTER TABLE "Record" DROP COLUMN value;',
    },
    async (options) => {
      await migrate(options);
      await assert.rejects(rollback({ ...options, steps: 2 }), /no down SQL/);
      assert.deepEqual(await migrationStatus(options), { applied: ['0001', '0002'], pending: [] });
      assert.deepEqual(await rollback(options), ['0002']);
    },
  );
});

test('overlapping migration tools wait for locks and reread history before selecting work', async () => {
  await project(recordMigrations, async (options) => {
    const contenders = createPool({
      connectionString: connection,
      maxConnections: 3,
      applicationName: options.namespace,
    });
    const queued = { ...options, connection: contenders };
    const pending: Promise<unknown>[] = [];
    function track<T>(promise: Promise<T>): Promise<T> {
      pending.push(promise);
      // Every outcome is awaited below; handle early failures while observing locks.
      void promise.catch(() => {});
      return promise;
    }
    let first!: ReturnType<typeof migrate>;
    let second!: ReturnType<typeof migrate>;
    let generated!: ReturnType<typeof generateDefinitions>;
    let reversed!: ReturnType<typeof rollback>;
    try {
      await withMigrationLock(options, 'exclusive', async () => {
        first = track(migrate(queued));
        await waitForAdvisoryWaiters(options.namespace, 1);
        second = track(migrate(queued));
        await waitForAdvisoryWaiters(options.namespace, 2);
        generated = track(generateDefinitions(queued));
        await waitForAdvisoryWaiters(options.namespace, 3);
      });
      assert.deepEqual(await first, ['0001']);
      assert.deepEqual(await second, []);
      assert.equal(await generated, await generateDefinitions(options));
      assert.deepEqual(await migrationStatus(options), { applied: ['0001'], pending: [] });
      await withMigrationLock(options, 'shared', async () => {
        // Shared generation locks coexist; an exclusive rollback must wait.
        assert.equal(await generateDefinitions(queued), await generated);
        reversed = track(rollback(queued));
        await waitForAdvisoryWaiters(options.namespace, 1);
      });
      assert.deepEqual(await reversed, ['0001']);
      await assert.rejects(
        withMigrationLock(queued, 'exclusive', async () => {
          throw new Error('tool failed');
        }),
        /tool failed/,
      );
      assert.deepEqual(
        await migrate({
          ...options,
          connection: connection,
        }),
        ['0001'],
      );
    } finally {
      await Promise.allSettled(pending);
      await contenders.close();
    }
  });
});

test('tool lock waits honor the connection lock_timeout and leave connections reusable', async () => {
  await project(recordMigrations, async (options) => {
    const limited = createPool({
      connectionString: connection,
      maxConnections: 1,
      startupParameters: { lock_timeout: '100ms' },
    });
    const timed = { ...options, connection: limited };
    try {
      await withMigrationLock(options, 'exclusive', async () => {
        await assert.rejects(migrate(timed), { code: '55P03' });
        await assert.rejects(generateDefinitions(timed), { code: '55P03' });
        await assert.rejects(migrationStatus(timed), { code: '55P03' });
        assert.equal(
          (await pool.queryClassic('SELECT to_regnamespace($1) AS name', [options.namespace]))
            .rows[0]!.name,
          null,
        );
        assert.equal(
          (await limited.queryClassic('SHOW lock_timeout', [])).rows[0]!.lock_timeout,
          '100ms',
        );
      });
      assert.deepEqual(await migrate(timed), ['0001']);
      await withMigrationLock(options, 'shared', async () => {
        await assert.rejects(rollback(timed), { code: '55P03' });
        await generateDefinitions(timed);
      });
      assert.deepEqual(await rollback(timed), ['0001']);
    } finally {
      await limited.close();
    }
  });
});
