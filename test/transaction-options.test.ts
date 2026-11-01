import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool, DriverError } from '@kequtech/pgclear';
import type { Transaction as NativeTransaction, TransactionOptions } from '@kequtech/pgclear';
import { createTenon, defineJob, sql } from '../src/index.js';
import type { Transaction } from '../src/index.js';
import { mockDriver } from './helpers/driver.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';
import { connectionProxy } from './helpers/connection-proxy.js';

const control = createPool({ connectionString: testConnection });
before(() => assertTestDatabase(control).then(() => {}));
after(() => control.close());

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for transaction state.');
    await delay(5);
  }
}

test('transaction options and callback results reach the driver without copying or error translation', async (t) => {
  const driver = mockDriver(t);
  const options: TransactionOptions = {
    signal: new AbortController().signal,
    timeoutMs: 1234,
    isolation: 'serializable',
    readOnly: true,
    deferrable: true,
  };
  const failure = new AggregateError([new Error('commit'), new Error('release')]);
  t.mock.method(
    driver.sql,
    'transaction',
    async <T>(work: (tx: NativeTransaction) => Promise<T>, received?: TransactionOptions) => {
      assert.equal(received, options);
      assert.equal(await work(driver.transaction), 42);
      throw failure;
    },
  );
  const db = createTenon({ connection: driver.sql });
  await assert.rejects(
    db.transaction(async () => 42, options),
    (error) => error === failure,
  );
  await db.close();
});

test('transaction isolation, read-only and deferrable settings reach PostgreSQL', async () => {
  const db = createTenon({ connection: testConnection });
  try {
    const result = await db.transaction(
      async (tx) =>
        tx.query(
          sql`SELECT
      current_setting('transaction_isolation') AS isolation,
      current_setting('transaction_read_only') AS read_only,
      current_setting('transaction_deferrable') AS deferrable`,
          { returns: 'one' },
        ),
      { isolation: 'serializable', readOnly: true, deferrable: true },
    );
    assert.deepEqual(result, { isolation: 'serializable', read_only: 'on', deferrable: 'on' });
  } finally {
    await db.close();
  }
});

for (const interruption of ['abort', 'timeout'] as const) {
  test(`${interruption} during pool acquisition does not invoke the callback`, async () => {
    const pool = createPool({ connectionString: testConnection, maxConnections: 1 });
    const db = createTenon({ connection: pool });
    const lease = await pool.acquire();
    const controller = new AbortController();
    let invoked = false;
    const outcome = assert.rejects(
      db.transaction(
        async () => {
          invoked = true;
        },
        interruption === 'abort' ? { signal: controller.signal } : { timeoutMs: 30 },
      ),
      { code: interruption === 'abort' ? 'PGCLEAR_ABORTED' : 'PGCLEAR_TIMEOUT' },
    );
    try {
      await until(() => pool.stats.waiting === 1);
      controller.abort();
      await outcome;
      assert.equal(invoked, false);
      assert.equal(pool.stats.waiting, 0);
    } finally {
      await lease.release();
      await db.close();
      await pool.close();
    }
  });
}

test('pre-aborted transactions perform no acquisition or callback', async () => {
  const db = createTenon({ connection: testConnection });
  let invoked = false;
  try {
    await assert.rejects(
      db.transaction(
        async () => {
          invoked = true;
        },
        { signal: AbortSignal.abort() },
      ),
      { code: 'PGCLEAR_ABORTED' },
    );
    assert.equal(invoked, false);
    assert.equal(db.native.stats.total, 0);
  } finally {
    await db.close();
  }
});

test('abort during active SQL cancels the statement, cleans up and leaves the pool usable', async () => {
  const db = createTenon({ connection: { connectionString: testConnection, maxConnections: 1 } });
  const controller = new AbortController();
  let pid = 0;
  const outcome = assert.rejects(
    db.transaction(
      async (tx) => {
        pid = (
          await tx.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`, { returns: 'one' })
        ).pid;
        await tx.query(sql`SELECT pg_sleep(20)`);
      },
      { signal: controller.signal },
    ),
    { code: 'PGCLEAR_ABORTED' },
  );
  try {
    await until(
      async () =>
        pid !== 0 &&
        (
          await control.queryClassic<{ sleeping: boolean }>(
            "SELECT coalesce(bool_or(wait_event = 'PgSleep'), false) AS sleeping FROM pg_stat_activity WHERE pid = $1",
            [pid],
          )
        ).rows[0]!.sleeping,
    );
    controller.abort();
    await outcome;
    assert.equal((await db.query(sql`SELECT 1`)).rows.length, 1);
  } finally {
    controller.abort();
    await outcome;
    await db.close();
  }
});

for (const interruption of ['abort', 'timeout'] as const) {
  test(`${interruption} during a callback wait expires the captured ORM transaction`, async () => {
    const db = createTenon({ connection: testConnection, jobs: true });
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    let captured: Transaction | undefined;
    const outcome = assert.rejects(
      db.transaction(
        async (tx) => {
          await tx.query(sql`SELECT 1`);
          captured = tx;
          await release.promise;
        },
        interruption === 'abort' ? { signal: controller.signal } : { timeoutMs: 100 },
      ),
      { code: interruption === 'abort' ? 'PGCLEAR_ABORTED' : 'PGCLEAR_TIMEOUT' },
    );
    try {
      await until(() => captured !== undefined);
      controller.abort();
      await outcome;
      await assert.rejects(captured!.query(sql`SELECT 2`));
      const definition = defineJob({ name: 'cancelled-scope', handler() {} });
      await assert.rejects(captured!.jobs.sendMany(definition, []), /transaction has finished/);
      assert.equal((await db.query(sql`SELECT 3`)).rows.length, 1);
    } finally {
      release.resolve();
      controller.abort();
      await outcome;
      await db.close();
    }
  });
}

for (const delivered of [false, true]) {
  test(
    `abort while COMMIT ${delivered ? 'response' : 'request'} is held preserves the driver's uncertain outcome`,
    { timeout: 15000 },
    async () => {
      const proxy = await connectionProxy(testConnection);
      const db = createTenon({ connection: proxy.connection });
      const controller = new AbortController();
      const outcome = db
        .transaction(
          async (tx) => {
            await tx.query(sql`SELECT 1`);
            proxy.hold(delivered ? 'responses' : 'requests');
          },
          { signal: controller.signal },
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      try {
        await until(() => proxy.buffered(delivered ? 'responses' : 'requests') > 0);
        controller.abort();
        const failure = await outcome;
        assert.ok(failure instanceof DriverError);
        assert.equal(failure.code, 'PGCLEAR_COMMIT_UNKNOWN');
      } finally {
        proxy.release();
        await proxy.close();
        await outcome;
        await db.close();
      }
    },
  );
}
