import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import postgres from 'postgres';
import { createTenon, sql, type QueryEvent } from '../src/index.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const admin = postgres(testConnection);
before(() => assertTestDatabase(admin));
after(() => admin.end());

function markedConnection(max: number) {
  const name = `tenon_native_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(testConnection);
  url.searchParams.set('application_name', name);
  url.searchParams.set('max', String(max));
  return { name, connection: url.toString() };
}

async function sessions(name: string) {
  return admin<{ pid: number }[]>`SELECT pid FROM pg_stat_activity
    WHERE application_name=${name} AND datname=current_database()`;
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
    const { connection, name } = markedConnection(1);
    const events: QueryEvent[] = [];
    const db = createTenon({
      connection,
      onQuery: (event) => {
        events.push(event);
      },
    });
    t.after(() => db.native.end({ timeout: 1 }));

    const [native] = await db.native<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
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
    await db.native.listen(name, receive);
    await db.query(sql`SELECT pg_notify(${name}, ${'before-close'})`);
    assert.equal(await delivered, 'before-close');
    assert.equal((await sessions(name)).length, 2, 'LISTEN owns a separate physical connection');

    await db.close();
    await db.close();
    await assertDisconnected(name);
    await assert.rejects(db.native`SELECT 1`, { code: 'CONNECTION_ENDED' });
    await assert.rejects(db.query(sql`SELECT 1`), /closed/);
  },
);

test(
  'closing a borrowed client wrapper preserves its native queries and listener',
  { timeout: 10000 },
  async (t) => {
    const { connection, name } = markedConnection(1);
    const native = postgres(connection);
    const db = createTenon({ connection: native });
    t.after(() => native.end({ timeout: 1 }));
    assert.equal(db.native, native, 'native is the supplied client, without a wrapper');
    let receive!: (payload: string) => void;
    const delivered = new Promise<string>((resolve) => {
      receive = resolve;
    });
    await db.native.listen(name, receive);
    await db.query(sql`SELECT 1`);

    await db.close();
    await db.close();
    await assert.rejects(db.query(sql`SELECT 1`), /closed/);
    assert.equal((await db.native<{ value: number }[]>`SELECT 42 AS value`)[0]!.value, 42);
    await admin`SELECT pg_notify(${name}, ${'after-wrapper-close'})`;
    assert.equal(await delivered, 'after-wrapper-close');
    assert.equal((await sessions(name)).length, 2);

    await db.native.end();
    await assertDisconnected(name);
    await assert.rejects(native`SELECT 1`, { code: 'CONNECTION_ENDED' });
  },
);

test(
  'native access stays pool-level while a Tenon transaction holds its own connection',
  { timeout: 10000 },
  async (t) => {
    const { connection, name } = markedConnection(2);
    const native = postgres(connection, { max: 2 });
    const db = createTenon({ connection: native });
    t.after(() => native.end({ timeout: 1 }));
    await db.transaction(async (tx) => {
      assert.ok(!('native' in tx));
      const transaction = await tx.query(sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`, {
        returns: 'one',
      });
      const [native] = await db.native<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      assert.notEqual(native!.pid, transaction.pid);
    });
    await db.close();
    await native.end();
    await assertDisconnected(name);
  },
);
