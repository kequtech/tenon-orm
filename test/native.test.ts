import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createPool, listen } from '@kequtech/pgclear';
import { createTenon, sql, type QueryEvent, type Transaction } from '../src/index.js';
import { testConnection } from './helpers/database.js';

function owned(maxConnections = 1) {
  return createTenon({ connection: { connectionString: testConnection, maxConnections } });
}

test('native queries share the owned pool, and dedicated listeners have separate ownership', async (t) => {
  const events: QueryEvent[] = [];
  const db = createTenon({
    connection: testConnection,
    onQuery: (event) => {
      events.push(event);
    },
  });
  t.after(() => db.close({ timeoutMs: 0 }));
  const first = (await db.native.queryClassic('SELECT pg_backend_pid() AS pid', [])).rows[0]!.pid;
  const second = await db.query(sql`SELECT pg_backend_pid() AS pid`, { returns: 'one' });
  assert.equal(first, second.pid);
  assert.equal(events.length, 1);
  const delivered = Promise.withResolvers<string>();
  const channel = 'tenon_native_' + process.pid;
  const listener = await listen(testConnection, {
    channels: [channel],
    onNotification: (event) => delivered.resolve(event.payload),
  });
  try {
    await db.query(sql`SELECT pg_notify(${channel},${'hello'})`);
    assert.equal(await delivered.promise, 'hello');
    await db.close();
    assert.equal(listener.status.state, 'connected');
    await assert.rejects(db.native.queryClassic('SELECT 1', []), { code: 'PGCLEAR_CLOSED' });
  } finally {
    await listener.close();
  }
});

test('closing a borrowed wrapper preserves the application pool and its held session', async () => {
  const pool = createPool({ connectionString: testConnection, maxConnections: 2 });
  const db = createTenon({ connection: pool });
  const lease = await pool.acquire();
  try {
    assert.equal(db.native, pool);
    await Promise.all([db.close({ timeoutMs: 0 }), db.close()]);
    await assert.rejects(db.query(sql`SELECT 1`), /closed/);
    assert.equal((await lease.queryClassic('SELECT 42 AS value', [])).rows[0]!.value, 42);
    assert.equal((await pool.queryClassic('SELECT 43 AS value', [])).rows[0]!.value, 43);
  } finally {
    await lease.release();
    await pool.close();
  }
});

test('native access stays pool-level while a transaction owns its session', async (t) => {
  const db = owned(2);
  t.after(() => db.close());
  await db.transaction(async (tx) => {
    const row = await tx.query(sql`SELECT pg_backend_pid() AS pid`, { returns: 'one' });
    const other = (await db.native.queryClassic('SELECT pg_backend_pid() AS pid', [])).rows[0]!;
    assert.notEqual(row.pid, other.pid);
  });
});

test('concurrent and reentrant close callers share completion and the first deadline', async () => {
  const db = owned();
  const original = db.native.close.bind(db.native);
  let reentrant: Promise<void> | undefined;
  let calls = 0;
  const mocked = mock.method(
    db.native,
    'close',
    async (options?: import('@kequtech/pgclear').CloseOptions) => {
      calls++;
      reentrant = db.close({ timeoutMs: 0 });
      await original(options);
    },
  );
  try {
    const first = db.close({ timeoutMs: 500 });
    assert.equal(db.close({ timeoutMs: 1 }), first);
    await first;
    assert.equal(reentrant, first);
    assert.equal(calls, 1);
  } finally {
    mocked.mock.restore();
    await original({ timeoutMs: 0 });
  }
});

test('close preserves the same shutdown failure for later callers', async () => {
  const db = owned();
  const original = db.native.close.bind(db.native);
  const failure = new Error('close failed');
  const mocked = mock.method(db.native, 'close', async () => {
    throw failure;
  });
  try {
    const first = db.close();
    await assert.rejects(first, (error) => error === failure);
    assert.equal(db.close(), first);
  } finally {
    mocked.mock.restore();
    await original({ timeoutMs: 0 });
  }
});

test('invalid close settings preserve a usable database', async (t) => {
  const db = owned();
  t.after(() => db.close());
  for (const options of [
    { timeoutMs: -1 },
    { timeoutMs: NaN },
    { timeoutMs: 1.5 },
    { timeoutMs: 'x' },
    { timeout: 1 },
    null,
  ])
    await assert.rejects(db.close(options as never));
  assert.equal((await db.query(sql`SELECT 1 AS value`, { returns: 'one' })).value, 1);
});

for (const force of [false, true])
  test(`owned close ${force ? 'expires' : 'drains'} pending work`, { timeout: 10000 }, async () => {
    const db = owned();
    const observer = createPool(testConnection);
    const pid = (await db.native.queryClassic('SELECT pg_backend_pid() AS pid', [])).rows[0]!.pid;
    const pending = db.query(sql`SELECT pg_sleep(${0.3})`);
    const settled = pending.then(
      () => true,
      () => false,
    );
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const row = (
          await observer.queryClassic(
            'SELECT state,wait_event FROM pg_stat_activity WHERE pid=$1',
            [pid as number],
          )
        ).rows[0];
        if (row?.state === 'active' && row.wait_event === 'PgSleep') break;
        if (attempt === 99) assert.fail('query did not dispatch');
        await pause(2);
      }
    } finally {
      await observer.close();
    }
    const closing = db.close({ timeoutMs: force ? 0 : 2000 });
    assert.equal(await settled, !force);
    await closing;
    await assert.rejects(db.query(sql`SELECT 1`), /closed/);
  });

for (const expire of [false, true])
  test(
    `owned close rejects acquisition waiters with ${expire ? 'immediate' : 'graceful'} shutdown`,
    { timeout: 10000 },
    async () => {
      const db = owned();
      const lease = await db.native.acquire();
      const queries = [db.query(sql`SELECT 1`), db.query(sql`SELECT 2`)];
      const settled = Promise.allSettled(queries);
      const closing = db.close({ timeoutMs: expire ? 0 : 2000 });
      if (!expire) await lease.release();
      await closing;
      const results = await settled;
      assert.ok(results.every((r) => r.status === 'rejected'));
      await lease.release();
    },
  );

test(
  'deadline shutdown expires a suspended transaction and its escaped callback handle',
  { timeout: 10000 },
  async () => {
    const db = owned();
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    let escaped!: Transaction;
    const pending = db.transaction(async (tx) => {
      escaped = tx;
      await tx.query(sql`SELECT 1`);
      entered.resolve();
      await finish.promise;
    });
    const rejected = assert.rejects(pending);
    await entered.promise;
    await db.close({ timeoutMs: 0 });
    await rejected;
    await assert.rejects(escaped.query(sql`SELECT 2`));
    finish.resolve();
  },
);

test('driver shutdown rejection remains observable through the shared close promise', async () => {
  const db = owned();
  const original = db.native.close.bind(db.native);
  const failure = new AggregateError([new Error('dispose')], 'cleanup');
  const mocked = mock.method(db.native, 'close', () => Promise.reject(failure));
  try {
    const closing = db.close({ timeoutMs: 0 });
    await assert.rejects(closing, (error) => error === failure);
    assert.equal(db.close(), closing);
  } finally {
    mocked.mock.restore();
    await original({ timeoutMs: 0 });
  }
});
