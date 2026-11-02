import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test, type TestContext } from 'node:test';
import {
  createPool,
  listen,
  DriverError,
  type Pool,
  type Transaction as NativeTransaction,
  type TransactionOptions,
} from '@kequtech/pgclear';
import {
  AffectedRowsError,
  createJobsMigration,
  createMigration,
  createTenon,
  defineJob,
  defineWorker,
  identifier,
  JobError,
  migrate,
  migrationStatus,
  rollback,
  sql,
} from '../src/index.js';
import type {
  Database,
  JobDefinition,
  QueryEvent,
  RunnerOptions,
  RunnerEvent,
  Transaction,
  TransactionalHandlerContext,
} from '../src/index.js';
import { connectionProxy } from './helpers/connection-proxy.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const control = createPool({ connectionString: testConnection });
const temporaryDatabase = `tenon_jobs_test_${randomUUID().replaceAll('-', '')}`;
let createdDatabase = false;
let pool: Pool;
let db: Database;
let jobsConnection: string;
const namespace = `tenon_jobs_test_${randomUUID().replaceAll('-', '')}`;
let directory: string;
const options = () => ({ connection: pool, directory, namespace });
const name = () => randomUUID();

async function until(check: () => Promise<boolean> | boolean) {
  const end = performance.now() + 8000;
  while (!(await check())) {
    if (performance.now() > end) throw new Error('Timed out waiting for Jobs integration state.');
    await delay(10);
  }
}

before(async () => {
  await assertTestDatabase(control);
  await control.queryClassic(`CREATE DATABASE "${temporaryDatabase}"`);
  createdDatabase = true;
  const url = new URL(testConnection);
  url.pathname = `/${temporaryDatabase}`;
  jobsConnection = url.toString();
  pool = createPool({ connectionString: jobsConnection, maxConnections: 6 });
  db = createTenon({ connection: pool });
  directory = await mkdtemp(join(tmpdir(), 'tenon-jobs-integration-'));
  const app = await createMigration({ name: 'application', directory });
  await writeFile(app.upPath, 'CREATE TABLE migration_marker (value integer);');
  await writeFile(app.downPath, 'DROP TABLE migration_marker;');
  const generated = await createJobsMigration({ directory });
  assert.equal(generated.id, '0002');
  assert.deepEqual(await migrate(options()), ['0001', '0002']);
  assert.deepEqual(await migrationStatus(options()), { applied: ['0001', '0002'], pending: [] });
});

after(async () => {
  try {
    await db?.close();
    await pool?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  } finally {
    try {
      if (createdDatabase) await control.queryClassic(`DROP DATABASE "${temporaryDatabase}"`);
    } finally {
      await control.close();
    }
  }
});

async function table() {
  const table = identifier(namespace, `app_${name().replaceAll('-', '')}`);
  await db.query(sql`CREATE TABLE ${table} (value integer NOT NULL)`);
  return table;
}

function start(
  t: TestContext,
  definition: JobDefinition<unknown>,
  settings: RunnerOptions = {},
  database = db,
) {
  const stop = new AbortController();
  const running = database.jobs.run([definition], {
    signal: stop.signal,
    pollIntervalMs: 10,
    recoveryIntervalMs: 30_000,
    shutdownTimeoutMs: 100,
    retentionMs: false,
    ...settings,
  });
  // Observe immediately, including while the test is waiting for a separate state transition.
  void running.catch(() => {});
  t.after(async () => {
    stop.abort();
    await running;
  });
  return { stop, running };
}

test('transaction submissions commit or roll back with app writes and notify only after commit', async (t) => {
  const app = await table();
  const child = defineJob({ name: name(), handler(_payload: number) {} });
  const notifications: string[] = [];
  const listener = await listen(jobsConnection, {
    channels: ['pgclear_jobs_ready'],
    onNotification: (notice) => {
      notifications.push(notice.channel);
    },
  });
  t.after(() => listener.close());
  let sentId = '';
  await db.transaction(async (tx) => {
    await tx.query(sql`INSERT INTO ${app} VALUES (1)`);
    sentId = (await tx.jobs.send(child, 1)).id;
    assert.equal(await db.jobs.get(sentId), null);
    assert.equal((await tx.jobs.get(sentId))?.payload, 1);
    await delay(30);
    assert.deepEqual(notifications, []);
  });
  await until(() => notifications.length > 0);
  assert.equal((await db.jobs.get(sentId))?.state, 'pending');
  const failure = new Error('abort app write');
  let rolledBackId = '';
  const received = notifications.length;
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(sql`INSERT INTO ${app} VALUES (2)`);
      rolledBackId = (await tx.jobs.request(child, 2, { key: 'rollback' })).id;
      throw failure;
    }),
    (error) => error === failure,
  );
  await delay(30);
  assert.equal(notifications.length, received);
  assert.equal(await db.jobs.get(rolledBackId), null);
  assert.deepEqual(await db.query(sql`SELECT * FROM ${app}`, { returns: 'many' }), [{ value: 1 }]);
});

test('handlers retain savepoint recovery, guarded concurrency, return modes and query observation', async (t) => {
  const observations: QueryEvent[] = [];
  const observed = createTenon({
    connection: pool,
    onQuery: (event) => {
      observations.push(event);
    },
  });
  t.after(() => observed.close());
  const app = await table();
  await db.query(sql`INSERT INTO ${app} VALUES (0)`);
  let captured: Transaction | undefined;
  const child = defineJob({ name: name(), handler(_payload: number) {} });
  const def = defineJob({
    name: name(),
    transactional: true,
    async handler(_payload: number, { tx }) {
      captured = tx;
      assert.equal('run' in tx.jobs, false);
      const rejected = tx.query(sql`UPDATE ${app} SET value = 99`, {
        affectedRows: { exact: 0 },
        label: 'jobs.guard',
      });
      const sent = tx.jobs.send(child, 7);
      const read = tx.query(sql<{ value: number }>`SELECT value FROM ${app}`, {
        returns: 'one',
        label: 'jobs.read',
      });
      await assert.rejects(rejected, AffectedRowsError);
      await sent;
      assert.equal((await read).value, 0);
      await assert.rejects(
        tx.query(sql`SELECT 1 / 0`, { affectedRows: { exact: 1 }, label: 'jobs.sql-error' }),
        { code: '22012' },
      );
      await tx.query(sql`UPDATE ${app} SET value = ${7}`, {
        affectedRows: { exact: 1 },
        returns: 'many',
        label: 'jobs.write',
      });
      assert.deepEqual(
        await tx.query(sql`SELECT value FROM ${app} WHERE false`, {
          returns: 'oneOrNone',
          label: 'jobs.empty',
        }),
        undefined,
      );
    },
  });
  const job = await db.jobs.send(def, 1);
  const { stop, running } = start(t, def, {}, observed);
  await until(async () => (await db.jobs.get(job.id))?.state === 'completed');
  stop.abort();
  await running;
  assert.deepEqual(await db.query(sql`SELECT value FROM ${app}`, { returns: 'many' }), [
    { value: 7 },
  ]);
  assert.equal((await db.jobs.find(child))[0]?.payload, 7);
  assert.equal(observations.find((event) => event.label === 'jobs.guard')?.outcome, 'error');
  assert.equal(observations.find((event) => event.label === 'jobs.read')?.outcome, 'success');
  // The runner's completion is the only unlabeled SELECT in this transaction.
  assert.equal(
    observations.filter(
      (event) => event.command === 'SELECT' && !event.label && event.outcome === 'success',
    ).length,
    1,
  );
  await assert.rejects(captured!.query(sql`SELECT 1`), /transaction has finished/);
  await assert.rejects(captured!.jobs.send(child, 2), /transaction has finished/);
});

test('handler writes, child submissions and completion are atomic across retries', async (t) => {
  const app = await table();
  const child = defineJob({ name: name(), handler(_payload: number) {} });
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  let childId = '';
  const def = defineJob({
    name: name(),
    transactional: true,
    maxAttempts: 2,
    retryDelayMs: 0,
    retryJitter: false,
    async handler(_payload: number, { tx, attempt }) {
      assert.deepEqual(await tx.query(sql`SELECT * FROM ${app}`, { returns: 'many' }), []);
      assert.equal((await tx.jobs.find(child)).length, 0);
      await tx.query(sql`INSERT INTO ${app} VALUES (${attempt})`);
      childId = (await tx.jobs.send(child, attempt)).id;
      if (attempt === 1) {
        await release.promise;
        throw new Error('retry this');
      }
    },
  });
  const job = await db.jobs.send(def, 1);
  const { stop, running } = start(t, def);
  try {
    await until(() => childId !== '');
    assert.equal(await db.jobs.get(childId), null);
    assert.deepEqual(await db.query(sql`SELECT * FROM ${app}`, { returns: 'many' }), []);
    release.resolve();
    await until(async () => (await db.jobs.get(job.id))?.state === 'completed');
    assert.deepEqual(await db.query(sql`SELECT * FROM ${app}`, { returns: 'many' }), [
      { value: 2 },
    ]);
    assert.deepEqual(
      (await db.jobs.find(child)).map((item) => item.payload),
      [2],
    );
    assert.deepEqual(
      (await db.jobs.attempts(job.id)).map((item) => item.outcome),
      ['completed', 'failed'],
    );
    stop.abort();
    await running;
  } finally {
    release.resolve();
  }
});

test('producer specifications bind ORM workers and report retries only after rollback and bookkeeping', async (t) => {
  const app = await table();
  const specification = defineJob<{ value: number }>({
    name: name(),
    maxAttempts: 2,
    retryDelayMs: 0,
    retryJitter: false,
  });
  const original = new Error('retry the original failure');
  const events: RunnerEvent[] = [];
  let policyCalls = 0;
  const def = defineWorker(specification, {
    transactional: true,
    async handler({ value }, { tx, attempt }) {
      await tx.query(sql`INSERT INTO ${app} VALUES (${value})`);
      if (attempt === 1) throw original;
    },
  });
  let id = '';
  await db.transaction(async (tx) => {
    id = (await tx.jobs.send(specification, { value: 7 })).id;
  });
  const { stop, running } = start(t, def, {
    async onHandlerError(failure) {
      policyCalls++;
      assert.equal(failure.error, original);
      assert.equal(failure.id, id);
      assert.equal(failure.attempt, 1);
      assert.equal(failure.transactional, true);
      assert.equal('payload' in failure, false);
      // An exclusive lock proves rollback released the handler's table lock before policy runs.
      await db.transaction(async (tx) => {
        await tx.query(sql`LOCK TABLE ${app} IN ACCESS EXCLUSIVE MODE NOWAIT`);
        assert.deepEqual(await tx.query(sql`SELECT * FROM ${app}`, { returns: 'many' }), []);
      });
      return 'continue' as const;
    },
    onEvent(event) {
      events.push(event);
    },
  });
  await until(() => events.some((event) => event.type === 'attemptCompleted'));
  stop.abort();
  await running;
  assert.equal(policyCalls, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ['attemptStarted', 'attemptFailed', 'attemptStarted', 'attemptCompleted'],
  );
  const failed = events.find((event) => event.type === 'attemptFailed')!;
  assert.equal(failed.error, original);
  assert.ok(failed.retryAt instanceof Date);
  assert.equal((await db.jobs.get(id))?.state, 'completed');
  assert.deepEqual(await db.query(sql`SELECT * FROM ${app}`, { returns: 'many' }), [{ value: 7 }]);
  assert.ok(events.every((event) => !('payload' in event)));
});

test('an independent transaction error can stop the runner without losing error identity', async () => {
  const original = new DriverError('PGCLEAR_COMMIT_UNKNOWN', 'Independent commit response lost.');
  const specification = defineJob<number>({ name: name() });
  const events: RunnerEvent[] = [];
  const def = defineWorker(specification, {
    async handler(value) {
      // An application-owned transaction's error remains an ordinary handler error until policy decides.
      await db.transaction(async () => {
        void value;
        throw original;
      });
    },
  });
  const job = await db.jobs.send(specification, 1);
  await assert.rejects(
    db.jobs.run([def], {
      onEvent(event) {
        events.push(event);
      },
      onHandlerError(failure) {
        assert.equal(failure.error, original);
        assert.equal(failure.transactional, false);
        return 'stop';
      },
    }),
    (error) => error === original,
  );
  assert.equal((await db.jobs.get(job.id))?.state, 'running');
  assert.equal((await db.jobs.attempts(job.id))[0]?.outcome, null);
  assert.deepEqual(
    events.map((event) => event.type),
    ['attemptStarted', 'runnerFailed'],
  );
  const failed = events.find((event) => event.type === 'runnerFailed')!;
  assert.equal(failed.error, original);
  assert.equal(failed.attempt?.id, job.id);
  assert.equal((await pool.queryClassic('SELECT 1')).rows.length, 1);
});

test('distinct jobs for one business request retain one durable result and follow-up after pruning', async (t) => {
  const requests = identifier(namespace, `requests_${name().replaceAll('-', '')}`);
  const notes = identifier(namespace, `notes_${name().replaceAll('-', '')}`);
  await db.query(sql`CREATE TABLE ${requests} (id uuid PRIMARY KEY, note_id uuid)`);
  await db.query(sql`CREATE TABLE ${notes} (id uuid PRIMARY KEY, body text NOT NULL)`);
  const requestId = randomUUID();
  await db.query(sql`INSERT INTO ${requests} (id) VALUES (${requestId})`);
  const analysis = defineJob({ name: name(), handler(_payload: { requestId: string }) {} });
  const finalize = defineJob({
    name: name(),
    transactional: true,
    async handler(payload: { requestId: string; noteId: string; text: string }, { tx }) {
      const request = await tx.query(
        sql<{ note_id: string | null }>`
        SELECT note_id FROM ${requests} WHERE id = ${payload.requestId} FOR UPDATE`,
        { returns: 'one' },
      );
      if (request.note_id !== null) return;
      await tx.query(sql`INSERT INTO ${notes} VALUES (${payload.noteId}, ${payload.text})`);
      await tx.query(
        sql`UPDATE ${requests} SET note_id = ${payload.noteId} WHERE id = ${payload.requestId}`,
        { affectedRows: { exact: 1 } },
      );
      await tx.jobs.request(analysis, { requestId: payload.requestId }, { key: payload.requestId });
    },
  });
  const parents = await Promise.all(
    [1, 2].map(() =>
      db.jobs.send(finalize, { requestId, noteId: randomUUID(), text: 'prepared result' }),
    ),
  );
  assert.notEqual(parents[0]!.id, parents[1]!.id);
  const { stop, running } = start(t, finalize, { concurrency: 2 });
  await until(async () => (await db.jobs.stats(finalize)).completed === 2);
  stop.abort();
  await running;
  const results = await db.query(sql<{ id: string; body: string }>`SELECT * FROM ${notes}`, {
    returns: 'many',
  });
  assert.equal(results.length, 1);
  const stored = await db.query(
    sql<{ note_id: string }>`SELECT note_id FROM ${requests} WHERE id = ${requestId}`,
    { returns: 'one' },
  );
  assert.equal(stored.note_id, results[0]!.id);
  assert.equal((await db.jobs.find(analysis)).length, 1);
  assert.equal(
    await db.jobs.prune(finalize, { before: new Date(Date.now() + 1000), states: ['completed'] }),
    2,
  );
  assert.equal((await db.jobs.find(finalize)).length, 0);
  assert.equal((await db.query(sql`SELECT * FROM ${notes}`, { returns: 'many' })).length, 1);
  assert.equal(
    (await db.query(sql<{ note_id: string }>`SELECT note_id FROM ${requests}`, { returns: 'one' }))
      .note_id,
    stored.note_id,
  );
});

for (const reason of ['deadline', 'shutdown', 'ownership'] as const) {
  test(`${reason} rolls back writes and expires a transaction while its handler ignores cancellation`, async (t) => {
    const app = await table();
    await db.query(sql`INSERT INTO ${app} VALUES (0)`);
    const release = Promise.withResolvers<void>();
    let context: TransactionalHandlerContext | undefined;
    const def = defineJob({
      name: name(),
      transactional: true,
      maxAttempts: 1,
      executionTimeoutMs: reason === 'deadline' ? 300 : 30_000,
      async handler(_payload: number, current) {
        await current.tx.query(sql`UPDATE ${app} SET value = 1`);
        context = current;
        await release.promise;
      },
    });
    const job = await db.jobs.send(def, 1);
    const { stop, running } = start(t, def, { leaseMs: 300, shutdownTimeoutMs: 20 });
    try {
      await until(() => context !== undefined);
      if (reason === 'shutdown') stop.abort();
      if (reason === 'ownership') {
        await pool.queryClassic(
          'UPDATE pgclear_jobs.jobs SET claim_token = $2::uuid WHERE id = $1::uuid',
          [job.id, randomUUID()],
        );
      }
      await until(() => context!.signal.aborted);
      // Obtaining this row lock proves cancellation completed a real rollback.
      const statement = sql`UPDATE ${app} SET value = value RETURNING value`;
      const result = await pool.queryClassic(statement.text, [], { timeoutMs: 2000 });
      assert.deepEqual(result.rows, [{ value: 0 }]);
      await assert.rejects(context!.tx.query(sql`UPDATE ${app} SET value = 99`));
      await assert.rejects(context!.tx.jobs.send(def, 2));
      await assert.rejects(context!.tx.jobs.sendMany(def, []), /transaction has finished/);
      assert.notEqual((await db.jobs.get(job.id))?.state, 'completed');
      stop.abort();
      await running;
    } finally {
      release.resolve();
      stop.abort();
      await running;
    }
  });
}

test('graceful shutdown lets accepted work finish and leaves the application pool usable', async (t) => {
  const release = Promise.withResolvers<void>();
  let entered = false;
  const def = defineJob({
    name: name(),
    transactional: true,
    async handler(_payload: number) {
      entered = true;
      await release.promise;
    },
  });
  const job = await db.jobs.send(def, 1);
  const { stop, running } = start(t, def, {
    shutdownTimeoutMs: 5000,
    notifications: jobsConnection,
  });
  try {
    await until(() => entered);
    stop.abort();
    release.resolve();
    await running;
    assert.equal((await db.jobs.get(job.id))?.state, 'completed');
    assert.equal((await pool.queryClassic('SELECT 1')).rows.length, 1);
  } finally {
    release.resolve();
  }
});

test('runner readiness is forwarded before dispatch and preserves startup callback errors', async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let readyCalls = 0;
  const def = defineJob({
    name: name(),
    handler(_payload: number) {
      calls++;
    },
  });
  const job = await db.jobs.send(def, 1);
  const { stop, running } = start(t, def, {
    async onReady() {
      readyCalls++;
      entered.resolve();
      await release.promise;
    },
  });
  try {
    await entered.promise;
    assert.equal(calls, 0);
    assert.equal((await db.jobs.get(job.id))?.state, 'pending');
    release.resolve();
    await until(async () => (await db.jobs.get(job.id))?.state === 'completed');
    stop.abort();
    await running;
    assert.equal(calls, 1);
    assert.equal(readyCalls, 1);
  } finally {
    release.resolve();
    stop.abort();
    await running;
  }
  const failure = new Error('application startup failed');
  await assert.rejects(
    db.jobs.run([def], {
      onReady() {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal((await pool.queryClassic('SELECT 1')).rows.length, 1);
});

test('permanent errors roll back writes and retain Jobs error semantics', async (t) => {
  const app = await table();
  const def = defineJob({
    name: name(),
    transactional: true,
    async handler(_payload: number, { tx }) {
      await tx.query(sql`INSERT INTO ${app} VALUES (1)`);
      throw new JobError('permanent', { retry: false });
    },
  });
  const job = await db.jobs.send(def, 1);
  const { stop, running } = start(t, def);
  await until(async () => (await db.jobs.get(job.id))?.state === 'failed');
  stop.abort();
  await running;
  assert.deepEqual(await db.query(sql`SELECT * FROM ${app}`, { returns: 'many' }), []);
  assert.equal((await db.jobs.attempts(job.id)).length, 1);
  assert.match((await db.jobs.get(job.id))!.lastError!, /permanent/);
});

for (const delivered of [false, true]) {
  test(
    `worker preserves an uncertain commit when its ${delivered ? 'response' : 'request'} is lost`,
    { timeout: 15000 },
    async () => {
      const app = await table();
      const proxy = await connectionProxy(jobsConnection);
      const client = createPool({ ...proxy.connection, maxConnections: 1 });
      const shared = new Proxy(pool, {
        get(target, key) {
          if (key === 'transaction')
            return <T>(work: (tx: NativeTransaction) => Promise<T>, options?: TransactionOptions) =>
              client.transaction(async (tx) => {
                const result = await work(tx);
                proxy.hold(delivered ? 'responses' : 'requests');
                return result;
              }, options);
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const worker = createTenon({ connection: shared });
      let calls = 0;
      const def = defineJob({
        name: name(),
        transactional: true,
        async handler(_payload: number, { tx }) {
          calls++;
          await tx.query(sql`INSERT INTO ${app} VALUES (1)`);
        },
      });
      const job = await db.jobs.send(def, 1);
      const stop = new AbortController();
      const events: RunnerEvent[] = [];
      const outcome = worker.jobs
        .run([def], {
          signal: stop.signal,
          shutdownTimeoutMs: 0,
          onEvent(event) {
            events.push(event);
          },
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      try {
        await until(() => proxy.buffered(delivered ? 'responses' : 'requests') > 0);
        if (delivered) await until(async () => (await db.jobs.get(job.id))?.state === 'completed');
        proxy.disconnect();
        const error = await outcome;
        assert.ok(error instanceof DriverError);
        assert.equal(error.code, 'PGCLEAR_COMMIT_UNKNOWN');
        assert.equal(
          events.some((event) => event.type === 'attemptCompleted'),
          false,
        );
        const failed = events.find((event) => event.type === 'runnerFailed');
        assert.equal(failed?.error, error);
        assert.equal(failed?.attempt?.id, job.id);
        assert.equal(calls, 1);
        assert.deepEqual(
          await db.query(sql`SELECT * FROM ${app}`, { returns: 'many' }),
          delivered ? [{ value: 1 }] : [],
        );
        assert.equal((await db.jobs.get(job.id))?.state, delivered ? 'completed' : 'running');
        assert.equal((await db.jobs.attempts(job.id))[0]?.outcome, delivered ? 'completed' : null);
      } finally {
        stop.abort();
        proxy.release();
        await proxy.close();
        await outcome;
        await worker.close();
        await client.close();
      }
    },
  );
}

test(
  'worker rollback cleanup failures remain visible after shutdown cancellation',
  { timeout: 15000 },
  async () => {
    const app = await table();
    const proxy = await connectionProxy(jobsConnection);
    const client = createPool({ ...proxy.connection, maxConnections: 1 });
    const shared = new Proxy(pool, {
      get(target, key) {
        if (key === 'transaction')
          return <T>(work: (tx: NativeTransaction) => Promise<T>, options?: TransactionOptions) =>
            client.transaction(async (tx) => {
              try {
                return await work(tx);
              } catch (error) {
                proxy.hold('responses');
                throw error;
              }
            }, options);
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const worker = createTenon({ connection: shared });
    let signal: AbortSignal | undefined;
    const def = defineJob({
      name: name(),
      transactional: true,
      async handler(_payload: number, context) {
        signal = context.signal;
        await context.tx.query(sql`INSERT INTO ${app} VALUES (1)`);
        throw new JobError('permanent failure', { retry: false });
      },
    });
    const job = await db.jobs.send(def, 1);
    const stop = new AbortController();
    const outcome = worker.jobs.run([def], { signal: stop.signal, shutdownTimeoutMs: 0 }).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await until(() => proxy.buffered('responses') > 0);
      stop.abort();
      await until(() => signal!.aborted);
      proxy.disconnect();
      const error = await outcome;
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.some((cause: unknown) => cause instanceof DriverError));
      assert.deepEqual(await db.query(sql`SELECT * FROM ${app}`, { returns: 'many' }), []);
      assert.equal((await db.jobs.get(job.id))?.state, 'running');
      assert.equal((await db.jobs.attempts(job.id))[0]?.outcome, null);
    } finally {
      stop.abort();
      proxy.release();
      await proxy.close();
      await outcome;
      await worker.close();
      await client.close();
    }
  },
);

test('generated migration rolls back and reapplies; missing or incompatible storage rejects startup', async () => {
  const def = defineJob({ name: name(), handler() {} });
  await pool.queryClassic('UPDATE pgclear_jobs.schema_version SET version = 99');
  try {
    await assert.rejects(db.jobs.run([def]), /schema is incompatible/);
  } finally {
    await pool.queryClassic('UPDATE pgclear_jobs.schema_version SET version = 1');
  }
  assert.deepEqual(await rollback(options()), ['0002']);
  await assert.rejects(db.jobs.run([def]), /schema is incompatible/);
  const ordinary = createTenon({ connection: pool });
  assert.equal((await ordinary.query(sql`SELECT 1`)).rows.length, 1);
  await ordinary.close();
  assert.deepEqual(await migrate(options()), ['0002']);
  assert.equal((await createJobsMigration({ directory })).created, false);
  assert.deepEqual(await migrate(options()), []);
});
