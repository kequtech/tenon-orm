import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineJob as nativeDefineJob, JobError as NativeJobError } from '@kequtech/pgclear-jobs';
import { createTenon, defineJob, JobError, sql } from '../src/index.js';
import { mockDriver, result } from './helpers/driver.js';

const definition = defineJob({ name: 'inert', handler(_payload: number) {} });
const id = '00000000-0000-4000-8000-000000000001';

test('definitions and facade access are inert without configuration or Jobs storage', async () => {
  const db = createTenon({ connection: undefined, jobs: true });
  assert.equal(db.jobs, db.jobs);
  const controller = new AbortController();
  controller.abort();
  await db.jobs.run([definition], { signal: controller.signal });
  await db.close();
  await assert.rejects(db.jobs.run([definition], { signal: controller.signal }), /closed/);
  await assert.rejects(db.jobs.sendMany(definition, []), /closed/);
  assert.equal(JobError, NativeJobError);
  assert.equal(nativeDefineJob({ name: 'native-inert', handler() {} }).name, 'native-inert');
});

test('every disabled record operation and runner reject without SQL or acquisition', async (t) => {
  const statements: string[] = [];
  const driver = mockDriver(t, async (text) => {
    statements.push(text);
    return result(text);
  });
  const db = createTenon({ connection: driver.sql });
  const jobs = db.jobs;
  const calls = [
    () => jobs.send(definition, 1),
    () => jobs.request(definition, 1, { key: 'one' }),
    () => jobs.sendMany(definition, []),
    () => jobs.get(id),
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
  for (const call of calls) await assert.rejects(call(), /Jobs are disabled/);
  assert.deepEqual(statements, []);
  assert.equal(driver.reserve.mock.callCount(), 0);
  await db.transaction(async (tx) => {
    assert.equal('run' in tx.jobs, false);
    assert.equal('install' in tx.jobs, false);
    await assert.rejects(tx.jobs.send(definition, 1), /Jobs are disabled/);
    await assert.rejects(tx.jobs.sendMany(definition, []), /Jobs are disabled/);
    await tx.query(sql`SELECT 1`);
  });
  assert.deepEqual(statements, ['SELECT 1']);
  await db.close();
});

test('invalid Jobs configuration is rejected before opening a database', () => {
  for (const jobs of [null, 'true', 1, {}]) {
    // @ts-expect-error Runtime config validation also protects JavaScript consumers.
    assert.throws(() => createTenon({ connection: undefined, jobs }), /jobs must be a boolean/);
  }
});

test('worker startup preserves original driver failures and leaves its borrowed pool open', async (t) => {
  const failure = new Error('database unavailable');
  const driver = mockDriver(t, async () => {
    throw failure;
  });
  const db = createTenon({ connection: driver.sql, jobs: true });
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
  const db = createTenon({ connection: driver.sql, jobs: true });
  let captured!: import('../src/index.js').Transaction;
  try {
    await db.transaction(async (tx) => {
      captured = tx;
      assert.deepEqual(await tx.jobs.sendMany(definition, []), []);
    });
    await assert.rejects(captured.jobs.sendMany(definition, []), /transaction has finished/);
    assert.deepEqual(statements, []);
  } finally {
    await db.close();
  }
});
