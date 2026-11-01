import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '@kequtech/pgclear';
import {
  createTenon,
  createMigration,
  createJobsMigration,
  defineJob,
  migrate,
  sql,
} from '@kequtech/tenon-orm';

const connection = process.env.TENON_TEST_DATABASE_URL;
const control = createPool({ connectionString: connection });
const database = `tenon_packed_jobs_${randomUUID().replaceAll('-', '')}`;
const directory = await mkdtemp(join(tmpdir(), 'tenon-packed-jobs-'));
let created = false;
let db;
let pool;
const stop = new AbortController();
let running;
try {
  const current = (await control.queryClassic('SELECT current_database() AS name')).rows[0].name;
  assert.equal(current, 'tenon_orm_test');
  await control.queryClassic(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(connection);
  url.pathname = `/${database}`;
  pool = createPool({ connectionString: url.toString(), maxConnections: 4 });
  const files = await createMigration({ directory, name: 'app' });
  await writeFile(
    files.upPath,
    'CREATE TABLE project (id integer PRIMARY KEY, revision integer NOT NULL);',
  );
  await writeFile(files.downPath, 'DROP TABLE project;');
  await createJobsMigration({ directory });
  assert.deepEqual(await migrate({ connection: pool, directory }), ['0001', '0002']);
  assert.equal((await createJobsMigration({ directory })).created, false);
  db = createTenon({ connection: pool, jobs: true });
  const child = defineJob({ name: 'child', handler() {} });
  let attempts = 0;
  const refresh = defineJob({
    name: 'refresh',
    transactional: true,
    maxAttempts: 2,
    retryDelayMs: 20,
    retryJitter: false,
    async handler(payload, { tx, attempt }) {
      attempts++;
      await tx.query(sql`UPDATE project SET revision = revision + 1 WHERE id = ${payload.id}`, {
        affectedRows: { exact: 1 },
      });
      await tx.jobs.send(child, { id: payload.id, attempt });
      if (attempt === 1) throw new Error('temporary dependency failure');
    },
  });
  let job;
  await db.transaction(async (tx) => {
    await tx.query(sql`INSERT INTO project VALUES (1, 0)`);
    job = await tx.jobs.request(refresh, { id: 1 }, { key: 'project:1', delayMs: 20 });
  });
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.jobs.send(child, { rollback: true });
      throw new Error('rollback producer');
    }),
    /rollback producer/,
  );
  assert.deepEqual(await db.jobs.find(child), []);
  const cancelled = await db.jobs.send(refresh, { id: 1 }, { delayMs: 60000 });
  await db.jobs.cancel(cancelled.id);
  running = db.jobs.run([refresh], { signal: stop.signal, pollIntervalMs: 10 });
  void running.catch(() => {});
  const end = performance.now() + 8000;
  while ((await db.jobs.get(job.id)).state !== 'completed') {
    if (performance.now() > end) throw new Error('Packed Jobs workflow did not complete.');
    await delay(10);
  }
  stop.abort();
  await running;
  assert.equal(attempts, 2);
  assert.deepEqual(await db.query(sql`SELECT * FROM project`, { returns: 'many' }), [
    { id: 1, revision: 1 },
  ]);
  assert.deepEqual(
    (await db.jobs.find(child)).map((item) => item.payload),
    [{ id: 1, attempt: 2 }],
  );
  assert.equal((await db.jobs.get(cancelled.id)).state, 'cancelled');
  assert.equal((await pool.queryClassic('SELECT 1')).rows.length, 1);
  assert.deepEqual(await migrate({ connection: pool, directory }), []);
  console.log('Installed Jobs lifecycle passed.');
} finally {
  stop.abort();
  try {
    await running;
  } finally {
    try {
      await db?.close();
      await pool?.close();
    } finally {
      try {
        if (created) await control.queryClassic(`DROP DATABASE "${database}"`);
      } finally {
        await control.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
