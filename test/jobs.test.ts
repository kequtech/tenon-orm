import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineJob as nativeDefineJob, JobError as NativeJobError } from '@kequtech/pgclear-jobs';
import { createTenon, defineJob, defineWorker, JobError } from '../src/index.js';
import { mockDriver, result } from './helpers/driver.js';

const definition = defineJob({ name: 'inert', handler(_payload: number) {} });
const id = '00000000-0000-4000-8000-000000000001';

test('definitions and facade access are inert without configuration or Jobs storage', async () => {
  const db = createTenon({ connection: undefined });
  assert.equal(db.jobs, db.jobs);
  const controller = new AbortController();
  controller.abort();
  let ready = false;
  await db.jobs.run([definition], {
    signal: controller.signal,
    onReady() {
      ready = true;
    },
  });
  assert.equal(ready, false);
  await db.close();
  await assert.rejects(db.jobs.run([definition], { signal: controller.signal }), /closed/);
  await assert.rejects(db.jobs.sendMany(definition, []), /closed/);
  await assert.rejects(db.jobs.getMany([]), /closed/);
  assert.throws(() => db.jobs.start([definition]), /closed/);
  assert.equal(JobError, NativeJobError);
  assert.equal(nativeDefineJob({ name: 'native-inert', handler() {} }).name, 'native-inert');
});

test('producer contracts and worker bindings remain inert and validate before pool access', async () => {
  const db = createTenon({ connection: undefined });
  const specification = defineJob<{ id: number }>({ name: 'producer-only', maxAttempts: 5 });
  const worker = defineWorker(specification, {
    transactional: true,
    handler(payload, { tx }) {
      void payload.id;
      void tx.jobs;
      throw new Error('A pre-aborted runner must not invoke its handler.');
    },
  });
  try {
    await assert.rejects(
      // @ts-expect-error JavaScript consumers also get startup validation.
      db.jobs.run([specification], { signal: AbortSignal.abort() }),
      /requires a handler/,
    );
    await db.jobs.run([worker], { signal: AbortSignal.abort() });
    assert.equal(worker.maxAttempts, 5);
    assert.equal('handler' in specification, false);
  } finally {
    await db.close();
  }
});

test('every record operation and runner reject after close without SQL or acquisition', async (t) => {
  const statements: string[] = [];
  const driver = mockDriver(t, async (text) => {
    statements.push(text);
    return result(text);
  });
  const db = createTenon({ connection: driver.sql });
  const jobs = db.jobs;
  await db.close();
  const calls = [
    () => jobs.send(definition, 1),
    () => jobs.request(definition, 1, { key: 'one' }),
    () => jobs.sendMany(definition, []),
    () => jobs.get(id),
    () => jobs.getMany([]),
    () => jobs.find(definition),
    () => jobs.reschedule(id, new Date()),
    () => jobs.update(definition, id, 2),
    () => jobs.cancel(id),
    () => jobs.retry(id),
    () => jobs.remove(id),
    () => jobs.prune(definition, { before: new Date() }),
    () => jobs.stats(definition),
    () => jobs.attempts(id),
    () => jobs.schedule(definition, 1, { cron: '* * * * *' }),
    () => jobs.schedules(definition),
    () => jobs.unschedule(definition),
    () => jobs.run([definition]),
  ];
  for (const call of calls) await assert.rejects(call(), /closed/);
  assert.deepEqual(statements, []);
  assert.equal(driver.reserve.mock.callCount(), 0);
});

test('the removed Jobs option is rejected as unknown before opening a database', () => {
  for (const jobs of [true, false]) {
    assert.throws(
      // @ts-expect-error Jobs requires no configuration option.
      () => createTenon({ connection: undefined, jobs }),
      /Unknown Tenon config option: jobs/,
    );
  }
});

test('worker startup preserves original driver failures and leaves its borrowed pool open', async (t) => {
  const failure = new Error('database unavailable');
  const driver = mockDriver(t, async () => {
    throw failure;
  });
  const db = createTenon({ connection: driver.sql });
  await assert.rejects(
    db.jobs.run([definition], { databaseTimeoutMs: 100 }),
    (error) => error === failure,
  );
  assert.equal(driver.end.mock.callCount(), 0);
  await db.close();
  assert.equal(driver.end.mock.callCount(), 0);
});

test('expired transaction facades reject empty batches before SQL', async (t) => {
  const statements: string[] = [];
  const driver = mockDriver(t, async (text) => {
    statements.push(text);
    return result(text);
  });
  const db = createTenon({ connection: driver.sql });
  let captured!: import('../src/index.js').Transaction;
  try {
    await db.transaction(async (tx) => {
      captured = tx;
      assert.equal('run' in tx.jobs, false);
      assert.equal('install' in tx.jobs, false);
      assert.deepEqual(await tx.jobs.sendMany(definition, []), []);
      assert.deepEqual(await tx.jobs.getMany([]), []);
    });
    await assert.rejects(captured.jobs.sendMany(definition, []), /transaction has finished/);
    await assert.rejects(captured.jobs.getMany([]), /transaction has finished/);
    assert.deepEqual(statements, []);
  } finally {
    await db.close();
  }
});
