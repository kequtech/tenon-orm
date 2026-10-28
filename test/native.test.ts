import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createTenon, sql, type QueryEvent } from '../src/index.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const admin = new Pool({ connectionString: testConnection });
before(() => assertTestDatabase(admin));
after(() => admin.end());

function markedConnection(max: number) {
  const name = `tenon_native_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(testConnection);
  url.searchParams.set('application_name', name);

  return { name, connection: { connectionString: url.toString(), max } };
}

async function sessions(name: string) {
  return (
    await admin.query<{ pid: number }>(
      'SELECT pid FROM pg_stat_activity\n    WHERE application_name=$1 AND datname=current_database()',
      [name],
    )
  ).rows;
}

async function assertDisconnected(name: string) {
  // Socket shutdown can finish before PostgreSQL removes the backend from its catalog.
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!(await sessions(name)).length) return;
    await pause(20);
  }
  assert.fail('Native query or listener connection remained open after shutdown.');
}

test(
  'native access shares the owned query pool and close shuts down queries and LISTEN',
  { timeout: 10000 },
  async (t) => {
    const { connection, name } = markedConnection(2);
    const events: QueryEvent[] = [];
    const db = createTenon({
      connection,
      onQuery: (event) => {
        events.push(event);
      },
    });
    t.after(() => db.close());

    const {
      rows: [native],
    } = await db.native.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const row = await db.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`, {
      returns: 'one',
      label: 'tenon-query',
    });
    assert.equal(row.pid, native!.pid);
    assert.equal(events.length, 1, 'native queries bypass Tenon query observation');
    assert.equal(events[0]!.label, 'tenon-query');

    let receive!: (payload: string) => void;
    const delivered = new Promise<string>((resolve) => {
      receive = resolve;
    });
    const listener = await db.native.connect();
    listener.on('error', () => {});
    listener.on('notification', (event) => receive(event.payload ?? ''));
    await listener.query(`LISTEN "${name}"`);
    await db.query(sql`SELECT pg_notify(${name}, ${'before-close'})`);
    assert.equal(await delivered, 'before-close');
    assert.equal((await sessions(name)).length, 2, 'LISTEN owns a separate physical connection');

    await listener.query('UNLISTEN *');
    listener.release();
    await db.close();
    await db.close();
    await assertDisconnected(name);
    await assert.rejects(db.native.query('SELECT 1'), /after calling end/);
    await assert.rejects(db.query(sql`SELECT 1`), /closed/);
  },
);

test(
  'closing a borrowed client wrapper preserves its native queries and listener',
  { timeout: 10000 },
  async (t) => {
    const { connection, name } = markedConnection(2);
    const native = new Pool(connection);
    const db = createTenon({ connection: native });
    t.after(() => (native.ending ? undefined : native.end()));
    assert.equal(db.native, native, 'native is the supplied client, without a wrapper');
    let receive!: (payload: string) => void;
    const delivered = new Promise<string>((resolve) => {
      receive = resolve;
    });
    const listener = await db.native.connect();
    listener.on('error', () => {});
    listener.on('notification', (event) => receive(event.payload ?? ''));
    await listener.query(`LISTEN "${name}"`);
    await db.query(sql`SELECT 1`);

    await Promise.all([db.close({ timeoutMs: 0 }), db.close()]);
    await assert.rejects(db.query(sql`SELECT 1`), /closed/);
    assert.equal(
      (await db.native.query<{ value: number }>('SELECT 42 AS value')).rows[0]!.value,
      42,
    );
    await admin.query('SELECT pg_notify($1, $2)', [name, 'after-wrapper-close']);
    assert.equal(await delivered, 'after-wrapper-close');
    assert.equal((await sessions(name)).length, 2);

    await listener.query('UNLISTEN *');
    listener.release();
    await db.native.end();
    await assertDisconnected(name);
    await assert.rejects(native.query('SELECT 1'), /after calling end/);
  },
);

test(
  'native access stays pool-level while a Tenon transaction holds its own connection',
  { timeout: 10000 },
  async (t) => {
    const { connection, name } = markedConnection(2);
    const native = new Pool({ ...connection, max: 2 });
    const db = createTenon({ connection: native });
    t.after(() => (native.ending ? undefined : native.end()));
    await db.transaction(async (tx) => {
      assert.ok(!('native' in tx));
      const transaction = await tx.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`, {
        returns: 'one',
      });
      const {
        rows: [native],
      } = await db.native.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      assert.notEqual(native!.pid, transaction.pid);
    });
    await db.close();
    await native.end();
    await assertDisconnected(name);
  },
);

test('concurrent close callers share completion and the first timeout, including reentrant callers', async (t) => {
  const db = createTenon({ connection: 'postgresql://unused' });
  const end = db.native.end.bind(db.native);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  t.after(async () => {
    finish();
    await end();
  });
  let calls = 0;
  let reentrant: Promise<void> | undefined;
  t.mock.method(db.native, 'end', () => {
    calls++;
    reentrant = db.close({ timeoutMs: 0 });
    return pending;
  });
  const options = { timeoutMs: 125 };
  const first = db.close(options);
  options.timeoutMs = 0;
  const second = db.close({ timeoutMs: 0 });
  assert.equal(first, second);
  let completed = false;
  void second.then(() => {
    completed = true;
  });
  await assert.rejects(db.query(sql`SELECT 1`), /closed/);
  await assert.rejects(
    db.transaction(async () => {}),
    /closed/,
  );
  assert.equal(calls, 1);
  assert.equal(reentrant, first);
  assert.equal(completed, false, 'every caller must wait for the actual shutdown');
  await pause(20);
  assert.equal(completed, false, 'later close calls must not shorten the first deadline');
  finish();
  await Promise.all([first, second]);
  assert.equal(completed, true);
  assert.equal(db.close(), first);
});

test('close preserves the same shutdown failure for later callers', async (t) => {
  const db = createTenon({ connection: 'postgresql://unused' });
  const end = db.native.end.bind(db.native);
  t.after(() => end());
  const failure = new Error('Shutdown failed');
  let calls = 0;
  t.mock.method(db.native, 'end', () => {
    calls++;
    throw failure;
  });
  const closing = db.close();
  await assert.rejects(closing, (error) => error === failure);
  assert.equal(db.close({ timeoutMs: 0 }), closing);
  await assert.rejects(db.close(), (error) => error === failure);
  assert.equal(calls, 1);
  await assert.rejects(db.query(sql`SELECT 1`), /closed/);
});

test('invalid close settings reject without closing a usable database', async (t) => {
  const db = createTenon({ connection: testConnection });
  t.after(() => db.close({ timeoutMs: 0 }));
  const invalid: unknown[] = [
    null,
    [],
    1,
    { extra: undefined },
    ...[-1, 0.5, NaN, Infinity, 2147483648, null, '5'].map((timeoutMs) => ({ timeoutMs })),
  ];
  for (const options of invalid) {
    await assert.rejects(
      db.close(options as import('../src/index.js').CloseOptions),
      /Close options|close option|Close timeoutMs/,
    );
  }
  assert.deepEqual(await db.query(sql`SELECT 42 AS value`, { returns: 'one' }), { value: 42 });
});

for (const force of [false, true]) {
  test(
    `owned close ${force ? 'rejects pending client work at its timeout' : 'allows work to drain before its timeout'}`,
    { timeout: 10000 },
    async (t) => {
      const { connection, name } = markedConnection(1);
      const db = createTenon({ connection });
      t.after(() => db.close({ timeoutMs: 0 }));
      t.after(async () => {
        // Ending a client is not a PostgreSQL CancelRequest. Cancel only this test's sleeper.
        for (const { pid } of await sessions(name))
          await admin.query('SELECT pg_cancel_backend($1)', [pid]);
        await assertDisconnected(name);
      });
      await db.query(sql`SELECT 1`);
      let completed = false;
      const running = db.query(sql`SELECT pg_sleep(${force ? 30 : 0.3})`).then(
        () => {
          completed = true;
          return undefined;
        },
        (error: unknown) => error,
      );
      // Observe the actual long-running statement before requesting shutdown.
      for (let attempt = 0; ; attempt++) {
        const active = (
          await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='PgSleep'",
            [name],
          )
        ).rows;
        if (active.length) break;
        assert.ok(attempt < 100, 'The test query did not start');
        await pause(10);
      }
      const started = performance.now();
      const first = db.close({ timeoutMs: force ? 50 : 3000 });
      assert.equal(db.close({ timeoutMs: 0 }), first);
      await first;
      const result = await running;
      if (force) {
        assert.ok(result instanceof Error);
        assert.equal(completed, false);
        assert.ok(
          performance.now() - started < 2000,
          'Shutdown must stop waiting for the active query',
        );
      } else {
        assert.equal(result, undefined);
        assert.equal(completed, true);
      }
      if (!force) await assertDisconnected(name);
    },
  );
}

for (const expire of [false, true]) {
  test(
    `owned close ${expire ? 'rejects' : 'drains'} accepted queries queued behind a busy connection`,
    { timeout: 10000 },
    async (t) => {
      const { connection, name } = markedConnection(1);
      const db = createTenon({ connection });
      t.after(async () => {
        for (const { pid } of await sessions(name))
          await admin.query('SELECT pg_cancel_backend($1)', [pid]);
        await db.close({ timeoutMs: 0 });
      });
      const operations = Array.from({ length: 3 }, (_, id) =>
        db.query(sql`SELECT pg_sleep(${expire ? 30 : 0.03}), ${id}::integer AS id`, {
          returns: 'one',
        }),
      );
      const results = Promise.allSettled(operations);
      await db.close({ timeoutMs: expire ? 30 : 3000 });
      const settled = await results;
      if (expire) assert.ok(settled.every((r) => r.status === 'rejected'));
      else
        assert.deepEqual(
          settled.map((r) => (r.status === 'fulfilled' ? r.value.id : r.reason)),
          [0, 1, 2],
        );
      await assert.rejects(db.native.query('SELECT 1'), /after calling end/);
    },
  );
}

test(
  'deadline shutdown ends idle clients once and expires a suspended transaction',
  { timeout: 10000 },
  async (t) => {
    const db = createTenon({ connection: testConnection });
    let entered!: () => void, resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let lateQuery!: Promise<unknown>;
    const transaction = db.transaction(async (tx) => {
      await tx.query(sql`SELECT 1`);
      entered();
      await gate;
      lateQuery = assert.rejects(tx.query(sql`SELECT 2`), /closed|connection/i);
      await lateQuery;
    });
    const rejected = assert.rejects(transaction, /shutdown deadline/);
    t.after(async () => {
      resume();
      await db.close({ timeoutMs: 0 });
    });
    await ready;
    const idle = await db.native.connect();
    const end = t.mock.method(idle, 'end');
    idle.release();
    await db.close({ timeoutMs: 0 });
    await rejected;
    assert.equal(end.mock.callCount(), 1, 'idle clients are ended by the pool, not again by Tenon');
    resume();
    for (let attempt = 0; !lateQuery; attempt++) {
      assert.ok(attempt < 100);
      await pause(5);
    }
    await lateQuery;
  },
);

test(
  'deadline termination failures reject the shared close promise',
  { timeout: 10000 },
  async (t) => {
    const db = createTenon({ connection: testConnection });
    let client!: PoolClient, entered!: () => void, resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    db.native.once('acquire', (acquired) => {
      client = acquired;
    });
    const transaction = db.transaction(async (tx) => {
      await tx.query(sql`SELECT 1`);
      entered();
      await gate;
    });
    const expired = assert.rejects(transaction, /shutdown deadline/);
    t.after(async () => {
      resume();
      await db.close({ timeoutMs: 0 }).catch(() => {});
    });
    await ready;
    const additional = await db.native.connect();
    additional.on('error', () => {});
    const additionalEnd = t.mock.method(additional, 'end');
    t.after(() => {
      additional.release(true);
    });
    const failure = new Error('Client termination failed');
    const original = client.end.bind(client);
    t.mock.method(client, 'end', (callback?: () => void) => {
      if (callback) return original(callback);
      void original();
      throw failure;
    });
    const closing = db.close({ timeoutMs: 0 });
    await assert.rejects(closing, (error) => error === failure);
    assert.equal(db.close(), closing);
    await assert.rejects(db.close(), (error) => error === failure);
    await expired;
    assert.equal(additionalEnd.mock.callCount(), 1, 'one failure must not skip other checkouts');
    resume();
  },
);
