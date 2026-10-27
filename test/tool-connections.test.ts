import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureBaseline, createTenon, type TenonOptions } from '../src/index.js';
import { withMigrationLock } from '../src/migrations/connection.js';
import { mockDriver, result } from './helpers/driver.js';

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

test('runtime and tools reject invalid connections before acquisition', async () => {
  for (const value of [undefined, null, '', ' ', 42, false, [], new Date()]) {
    const connection = value as TenonOptions['connection'];
    assert.throws(() => createTenon({ connection }));
    await assert.rejects(withMigrationLock({ connection }, 'shared', async () => {}));
  }
  await createTenon({ connection: {} }).close();
});

test('tools release borrowed sessions without closing the application client', async (t) => {
  const driver = mockDriver(t);
  assert.equal(await withMigrationLock({ connection: driver.sql }, 'shared', async () => 42), 42);
  assert.equal(driver.release.mock.callCount(), 1);
  assert.equal(driver.end.mock.callCount(), 0);
});

test('tools preserve work and rollback failures and discard the failed session', async (t) => {
  const work = new Error('work failed'),
    rollback = new Error('rollback failed');
  const driver = mockDriver(t, async (text) => {
    if (text === 'ROLLBACK') throw rollback;
    return result(text);
  });
  await assert.rejects(
    withMigrationLock({ connection: driver.sql }, 'exclusive', async () => {
      throw work;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [work, rollback]);
      return true;
    },
  );
  assert.equal(driver.discard.mock.callCount(), 1);
  assert.equal(driver.release.mock.callCount(), 0);
});

test('an advisory unlock failure rejects successful work and discards the session', async (t) => {
  const failure = new Error('unlock failed');
  const driver = mockDriver(t, async (text) => {
    if (text.includes('pg_advisory_unlock')) throw failure;
    return result(text);
  });
  await assert.rejects(
    withMigrationLock({ connection: driver.sql }, 'shared', async () => 42),
    (error) => error === failure,
  );
  assert.equal(driver.discard.mock.callCount(), 1);
  assert.equal(driver.release.mock.callCount(), 0);
});

test('a non-Error rejection remains a failure after successful cleanup', async (t) => {
  const driver = mockDriver(t);
  await assert.rejects(
    withMigrationLock({ connection: driver.sql }, 'shared', async () => {
      throw undefined;
    }),
    (error) => error === undefined,
  );
  assert.equal(driver.release.mock.callCount(), 1);
});
