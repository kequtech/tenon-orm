import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough, type Duplex } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import postgres from 'postgres';
import { createTenon } from '../src/index.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';
import { postgresProxy } from './helpers/proxy.js';

const admin = postgres(testConnection);
before(() => assertTestDatabase(admin));
after(() => admin.end());

async function eventually(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await pause(10);
  }
  assert.fail('Listener condition did not settle.');
}

test(
  'an owned listener still reconnects and delivers notifications before shutdown',
  { timeout: 10000 },
  async (t) => {
    const proxy = await postgresProxy(testConnection);
    const db = createTenon({ connection: proxy.connection });
    t.after(async () => {
      await db.close();
      await proxy.close();
    });
    const channel = `tenon_reconnect_${randomUUID().replaceAll('-', '')}`;
    let ready = 0;
    const payloads: string[] = [];
    await db.native.listen(
      channel,
      (payload) => {
        payloads.push(payload);
      },
      () => {
        ready++;
      },
    );
    const attempts = proxy.attempts;
    proxy.setAvailable(false);
    await eventually(() => proxy.attempts > attempts);
    proxy.setAvailable(true);
    await eventually(() => ready === 2);
    await admin`SELECT pg_notify(${channel}, 'recovered')`;
    await eventually(() => payloads.length === 1);
    assert.deepEqual(payloads, ['recovered']);
    await db.close();
    await eventually(() => proxy.sockets === 0);
  },
);

test(
  'owned shutdown preserves a custom socket factory and disposes a late result',
  { timeout: 10000 },
  async (t) => {
    const db = createTenon({ connection: testConnection });
    t.after(() => db.native.end({ timeout: 1 }));
    let finish!: (socket: Duplex) => void;
    const pending = new Promise<Duplex>((resolve) => {
      finish = resolve;
    });
    let called = false;
    const factory = () => {
      called = true;
      return pending;
    };
    const options: typeof db.native.options & { socket?: () => Promise<Duplex> } =
      db.native.options;
    options.socket = factory;
    const subscription = db.native
      .listen('tenon_late_socket', () => {})
      .catch((error: unknown) => error);
    await eventually(() => called);
    assert.equal(options.socket, factory, 'the query pool retains the caller socket factory');
    await db.close();
    assert.ok((await subscription) instanceof Error);
    const socket = new PassThrough();
    finish(socket);
    await eventually(() => socket.destroyed);
  },
);

for (const pendingSetup of [false, true]) {
  test(
    `owned close prevents LISTEN from reconnecting after shutdown (pending setup=${pendingSetup})`,
    { timeout: 10000 },
    async (t) => {
      const proxy = await postgresProxy(testConnection);
      const name = `tenon_shutdown_${randomUUID().replaceAll('-', '')}`;
      const url = new URL(proxy.connection);
      url.searchParams.set('application_name', name);
      url.searchParams.set('backoff', '0.05');
      const db = createTenon({ connection: url.toString() });
      t.after(async () => {
        await proxy.close();
        await db.native.end({ timeout: 1 });
      });
      let ready = 0,
        notifications = 0;
      const subscribe = () =>
        db.native.listen(
          name,
          () => {
            notifications++;
          },
          () => {
            ready++;
          },
        );
      let subscription: Promise<unknown> | undefined;
      if (pendingSetup) {
        proxy.setAvailable(false);
        subscription = subscribe().catch((error: unknown) => error);
        await eventually(() => proxy.attempts >= 2);
      } else {
        await subscribe();
        await admin`SELECT pg_notify(${name}, 'before-close')`;
        await eventually(() => notifications === 1);
        const attempts = proxy.attempts;
        proxy.setAvailable(false);
        await eventually(() => proxy.attempts > attempts);
      }
      await db.close();
      await db.close();
      if (subscription) assert.ok((await subscription) instanceof Error);
      const attemptsAtClose = proxy.attempts;
      const readyAtClose = ready;
      proxy.setAvailable(true);
      // Ten test backoff windows: a canceled reconnect must not restore an idle backend.
      await pause(500);
      assert.equal(
        (await admin`SELECT pid FROM pg_stat_activity WHERE application_name=${name}`).length,
        0,
        'LISTEN must not restore a backend after db.close()',
      );
      // A TCP attempt already in flight may reach the proxy after its client was destroyed.
      assert.ok(proxy.attempts <= attemptsAtClose + 1);
      assert.equal(proxy.sockets, 0);
      assert.equal(ready, readyAtClose);
      await admin`SELECT pg_notify(${name}, 'after-close')`;
      assert.equal(notifications, pendingSetup ? 0 : 1);
      const settledAttempts = proxy.attempts;
      await pause(100);
      assert.equal(proxy.attempts, settledAttempts, 'shutdown stops reconnect activity');
      await assert.rejects(subscribe(), { code: 'CONNECTION_ENDED' });
    },
  );
}
