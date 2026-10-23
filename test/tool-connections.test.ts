import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { captureBaseline, createTenon, type TenonOptions } from '../src/index.js';
import { withMigrationLock } from '../src/migrations/connection.js';

function mockClient(t: TestContext, query: (sql: string) => Promise<unknown>) {
  const release = t.mock.fn();
  const client = Object.assign(new EventEmitter(), { query, release }) as unknown as PoolClient;
  return { client, release };
}

const emptyResult = { rows: [], fields: [], rowCount: null, command: '', oid: 0 };

test('baseline capture rejects implicit connections and empty schema selections before creating files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-baseline-options-'));
  const directory = join(root, 'migrations');
  try {
    for (const connection of [undefined, null, '', '  ', 42, false, {}]) {
      await assert.rejects(
        captureBaseline({ connection: connection as string, directory }),
        /explicit nonempty connection string/,
      );
    }
    await assert.rejects(
      captureBaseline({ connection: 'postgresql://unused', directory, schemas: [] }),
      /schemas must not be empty/,
    );
    await assert.rejects(access(directory), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime and tools reject missing or invalid connections before acquiring a client', async (t) => {
  const connect = t.mock.method(Pool.prototype, 'connect', async () => {
    throw new Error('unexpected connection');
  });
  for (const value of [undefined, null, '', '  ', 42, false, [], new Date()]) {
    const connection = value as TenonOptions['connection'];
    assert.throws(() => createTenon({ connection }), Error);
    await assert.rejects(
      withMigrationLock({ connection }, 'shared', async () => {}),
      Error,
    );
  }
  // Explicit pg configuration retains its normal environment/default behavior.
  await createTenon({ connection: {} }).close();
  assert.equal(connect.mock.callCount(), 0);
});

test('tools release a borrowed connection without ending the application pool', async (t) => {
  const pool = new Pool();
  const { client, release } = mockClient(t, async () => emptyResult);
  t.mock.method(pool, 'connect', async () => client);
  const end = t.mock.method(pool, 'end', async () => {});

  const result = await withMigrationLock({ connection: pool }, 'shared', async () => 42);
  assert.equal(result, 42);
  assert.equal(release.mock.callCount(), 1);
  assert.deepEqual(release.mock.calls[0]!.arguments, [undefined]);
  assert.equal(end.mock.callCount(), 0);
});

test('tools close owned pools when connection acquisition fails', async (t) => {
  const failure = new Error('connection unavailable');
  t.mock.method(Pool.prototype, 'connect', async () => {
    throw failure;
  });
  const end = t.mock.method(Pool.prototype, 'end', async () => {});

  await assert.rejects(
    withMigrationLock({ connection: {} }, 'exclusive', async () => {}),
    (error) => error === failure,
  );
  assert.equal(end.mock.callCount(), 1);
});

test('tools preserve both the work error and rollback failure and discard the connection', async (t) => {
  const failure = new Error('work failed');
  const rollback = new Error('rollback failed');
  const { client, release } = mockClient(t, async (sql) => {
    if (sql === 'ROLLBACK') throw rollback;
    return emptyResult;
  });
  t.mock.method(Pool.prototype, 'connect', async () => client);
  const end = t.mock.method(Pool.prototype, 'end', async () => {});

  await assert.rejects(
    withMigrationLock({ connection: {} }, 'exclusive', async () => {
      throw failure;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure, rollback]);
      return true;
    },
  );
  assert.deepEqual(release.mock.calls[0]!.arguments, [rollback]);
  assert.equal(release.mock.callCount(), 1);
  assert.equal(end.mock.callCount(), 1);
});

test('a failed advisory unlock rejects successful work and discards the connection', async (t) => {
  const failure = new Error('connection lost during unlock');
  const pool = new Pool();
  const { client, release } = mockClient(t, async (sql) => {
    if (sql.includes('pg_advisory_unlock')) throw failure;
    return emptyResult;
  });
  t.mock.method(pool, 'connect', async () => client);

  try {
    await assert.rejects(
      withMigrationLock({ connection: pool }, 'shared', async () => 'saved'),
      (error) => error === failure,
    );
    assert.deepEqual(release.mock.calls[0]!.arguments, [failure]);
    assert.equal(release.mock.callCount(), 1);
  } finally {
    await pool.end();
  }
});

test('pool shutdown errors do not hide work and connection cleanup failures', async (t) => {
  const work = new Error('work failed');
  const cleanup = new Error('cleanup failed');
  const shutdown = new Error('shutdown failed');
  const { client } = mockClient(t, async (sql) => {
    if (sql === 'ROLLBACK') throw cleanup;
    return emptyResult;
  });
  t.mock.method(Pool.prototype, 'connect', async () => client);
  t.mock.method(Pool.prototype, 'end', async () => {
    throw shutdown;
  });

  await assert.rejects(
    withMigrationLock({ connection: {} }, 'exclusive', async () => {
      throw work;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [work, cleanup, shutdown]);
      return true;
    },
  );
});

test('a non-Error rejection remains a failure after successful cleanup', async (t) => {
  const { client, release } = mockClient(t, async () => emptyResult);
  t.mock.method(Pool.prototype, 'connect', async () => client);
  const end = t.mock.method(Pool.prototype, 'end', async () => {});

  await assert.rejects(
    withMigrationLock({ connection: {} }, 'exclusive', async () => {
      throw undefined;
    }),
    (error) => error === undefined,
  );
  assert.equal(release.mock.callCount(), 1);
  assert.equal(end.mock.callCount(), 1);
});
