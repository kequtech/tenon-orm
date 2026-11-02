import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { createPool } from '@kequtech/pgclear';
import { createTenon, sql, identifier, builtin, param } from '../src/index.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const control = createPool(testConnection);
before(() => assertTestDatabase(control));
after(() => control.close());

async function active(name: string) {
  for (let i = 0; i < 500; i++) {
    const { rows } = await control.queryClassic(
      `SELECT 1 FROM pg_stat_activity
      WHERE application_name=$1 AND state='active' AND query LIKE '%pg_sleep%'`,
      [name],
    );
    if (rows.length) return;
    await delay(5);
  }
  throw new Error('Query never became active.');
}

test('pre-aborted and zero-timeout queries do not construct a connection', async () => {
  const db = createTenon({ connection: { connectionString: undefined } });
  try {
    await assert.rejects(db.query(sql`SELECT 1`, { signal: AbortSignal.abort() }), {
      code: 'PGCLEAR_ABORTED',
    });
    await assert.rejects(db.query(sql`SELECT 1`, { timeoutMs: 0, affectedRows: { exact: 1 } }), {
      code: 'PGCLEAR_TIMEOUT',
    });
    for (const timeoutMs of [-1, NaN, Infinity, 1.5, 2147483648])
      await assert.rejects(db.query(sql`SELECT 1`, { timeoutMs }), /Query timeoutMs/);
    // @ts-expect-error Validate untyped callers as well.
    await assert.rejects(db.query(sql`SELECT 1`, { signal: {} }), /AbortSignal/);
  } finally {
    await db.close();
  }
});

test('query timeouts include pool acquisition for ordinary and guarded writes', async () => {
  const pool = createPool({ connectionString: testConnection, maxConnections: 1 });
  const db = createTenon({ connection: pool });
  const lease = await pool.acquire();
  try {
    await assert.rejects(db.query(sql`SELECT 1`, { timeoutMs: 25 }), { code: 'PGCLEAR_TIMEOUT' });
    await assert.rejects(
      db.query(sql`DELETE FROM missing_table`, { timeoutMs: 25, affectedRows: { max: 1 } }),
      { code: 'PGCLEAR_TIMEOUT' },
    );
  } finally {
    await lease.release();
    await db.close();
    await pool.close();
  }
});

test('active root cancellation preserves driver evidence and query observation', async () => {
  const name = `tenon_cancel_${randomUUID()}`;
  const events: string[] = [];
  const db = createTenon({
    connection: { connectionString: testConnection, applicationName: name },
    onQuery(event) {
      if (event.errorCode) events.push(event.errorCode);
    },
  });
  const stop = new AbortController();
  const pending = db.query(sql`SELECT pg_sleep(10)`, { signal: stop.signal, label: 'slow-read' });
  const rejected = assert.rejects(pending, { code: 'PGCLEAR_ABORTED' });
  try {
    await active(name);
    stop.abort();
    await rejected;
    assert.deepEqual(events, ['PGCLEAR_ABORTED']);
    assert.deepEqual(await db.query(sql`SELECT ${'ready'} AS status`, { returns: 'one' }), {
      status: 'ready',
    });
  } finally {
    stop.abort();
    await rejected;
    await db.close();
  }
});

test('a cancelled queued query rejects promptly, never executes, and preserves operation order', async () => {
  const db = createTenon({ connection: testConnection });
  try {
    await db.transaction(async (tx) => {
      await tx.query(sql`CREATE TEMP TABLE queued_updates (value integer) ON COMMIT DROP`);
      let firstDone = false;
      const first = tx
        .query(sql`INSERT INTO queued_updates SELECT 1 FROM pg_sleep(0.2)`, {
          affectedRows: { exact: 1 },
        })
        .finally(() => {
          firstDone = true;
        });
      await assert.rejects(
        tx.query(sql`INSERT INTO queued_updates VALUES (2)`, {
          timeoutMs: 25,
          affectedRows: { exact: 1 },
        }),
        { code: 'PGCLEAR_TIMEOUT' },
      );
      assert.equal(firstDone, false);
      const after = tx.query(sql`SELECT value FROM queued_updates`, { returns: 'many' });
      await first;
      assert.deepEqual(await after, [{ value: 1 }]);
    });
  } finally {
    await db.close();
  }
});

test('query cancellation cannot extend a transaction deadline', async () => {
  const db = createTenon({ connection: testConnection });
  try {
    await assert.rejects(
      db.transaction((tx) => tx.query(sql`SELECT pg_sleep(10)`, { timeoutMs: 5000 }), {
        timeoutMs: 40,
      }),
      { code: 'PGCLEAR_TIMEOUT' },
    );
  } finally {
    await db.close();
  }
});

test('a synchronous encoder cannot dispatch a query after its deadline', async () => {
  const db = createTenon({ connection: { connectionString: testConnection, maxConnections: 1 } });
  let encoded = false;
  const codec = {
    ...builtin.text,
    text: {
      ...builtin.text.text!,
      encode(value: string) {
        encoded = true;
        const end = performance.now() + 40;
        while (performance.now() < end) {
          /* Simulate a synchronous application encoder. */
        }
        return value;
      },
    },
  };
  try {
    await db.query(sql`SELECT 1`);
    await assert.rejects(
      db.query(sql`SELECT ${param('late', codec)} AS value`, { timeoutMs: 15 }),
      {
        code: 'PGCLEAR_TIMEOUT',
        outcome: 'not-sent',
      },
    );
    assert.equal(encoded, true);
  } finally {
    await db.close();
  }
});

test('an actively cancelled transaction scope expires rather than continuing on another connection', async () => {
  const name = `tenon_cancel_${randomUUID()}`;
  const db = createTenon({
    connection: { connectionString: testConnection, applicationName: name },
  });
  const stop = new AbortController();
  let expired: import('../src/index.js').Transaction | undefined;
  const pending = db.transaction(async (tx) => {
    expired = tx;
    await tx.query(sql`SELECT pg_sleep(10)`, { signal: stop.signal });
  });
  const rejected = assert.rejects(pending, { code: 'PGCLEAR_ABORTED' });
  try {
    await active(name);
    stop.abort();
    await rejected;
    await assert.rejects(expired!.query(sql`SELECT 1`), /finished/);
  } finally {
    stop.abort();
    await rejected;
    await db.close();
  }
});

test('cancelled guarded writes roll back before rejection', async () => {
  await migrationProject(control)({}, async (project) => {
    const table = identifier(project.namespace, 'cancelled_write');
    await control.queryClassic(`CREATE SCHEMA "${project.namespace}"`);
    await control.queryClassic(
      `CREATE TABLE "${project.namespace}".cancelled_write (value integer)`,
    );
    await control.queryClassic(`INSERT INTO "${project.namespace}".cancelled_write VALUES (0)`);
    const name = `tenon_cancel_${randomUUID()}`;
    const db = createTenon({
      connection: { connectionString: testConnection, applicationName: name },
    });
    const stop = new AbortController();
    const pending = db.query(sql`UPDATE ${table} SET value=1 RETURNING pg_sleep(10)`, {
      signal: stop.signal,
      affectedRows: { exact: 1 },
    });
    const rejected = assert.rejects(pending, { code: 'PGCLEAR_ABORTED' });
    try {
      await active(name);
      stop.abort();
      await rejected;
      assert.deepEqual(await db.query(sql`SELECT value FROM ${table}`, { returns: 'many' }), [
        { value: 0 },
      ]);
    } finally {
      stop.abort();
      await rejected;
      await db.close();
    }
  });
});
