import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import postgres from 'postgres';
import { createTenon, sql, unsafeSql } from '../src/index.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const admin = postgres(testConnection);
before(() => assertTestDatabase(admin));
after(() => admin.end());

for (const prepare of [true, false]) {
  test(`compiled queries preserve corrected parsers and avoid cached parsers with client prepare=${prepare}`, async () => {
    const native = postgres(testConnection, { max: 1, prepare });
    const text = 'SELECT $1::integer[] AS values, $2::jsonb AS payload, $3::bigint AS big';
    const options = { simple: false, prepare: true };
    const value = [1, null, 3];
    const payload = { nested: ['one', null] };
    const big = 9007199254740993n;
    const db = createTenon({ connection: native });
    try {
      // Describe before Tenon initializes: the native cached columns retain their old parsers.
      const original = await native
        .unsafe(text, [native.typed(value, 0), payload, native.typed(big, 20)], options)
        .describe();
      const query = unsafeSql(text, [value, payload, big]);
      const first = await db.query(query);
      const second = await db.query(query);
      const transaction = await db.transaction((tx) => tx.query(query));
      for (const result of [first, second, transaction]) {
        assert.deepEqual([...result], [{ values: [1, null, 3], payload, big: String(big) }]);
        assert.equal(result.statement.name, '');
      }
      assert.equal(first.statement.name, second.statement.name);
      assert.equal(first.statement.name, transaction.statement.name);
      if (prepare) assert.notEqual(first.statement.name, original.name);
      assert.equal(query.text, text, 'driver preparation must not change the detached query');
    } finally {
      await db.close();
      await native.end({ timeout: 1 });
    }
  });
}

test(
  'a JSON serialization failure preserves guarded transaction recovery',
  { timeout: 10000 },
  async (t) => {
    const native = postgres(testConnection, { max: 1 });
    const db = createTenon({ connection: native });
    t.after(async () => {
      await db.close();
      await native.end({ timeout: 1 });
    });
    await native.unsafe(`CREATE TEMP TABLE preparation_json (payload jsonb);
      CREATE TEMP TABLE preparation_audit (value text)`);
    const insert = (payload: object) =>
      sql`INSERT INTO preparation_json VALUES (${payload}::jsonb)`;
    await db.transaction(async (tx) => {
      await tx.query(sql`INSERT INTO preparation_audit VALUES (${'kept'})`);
      await assert.rejects(
        tx.query(insert({ invalid: 1n }), { affectedRows: { exact: 1 } }),
        TypeError,
      );
      await tx.query(insert({ valid: true }), { affectedRows: { exact: 1 } });
    });
    assert.deepEqual(
      [...(await native.unsafe('SELECT * FROM preparation_json'))],
      [{ payload: { valid: true } }],
    );
    assert.deepEqual(
      [...(await native.unsafe('SELECT * FROM preparation_audit'))],
      [{ value: 'kept' }],
    );
  },
);

test(
  'a concurrent serialization failure rejects its own query without shifting other results',
  { timeout: 10000 },
  async (t) => {
    const native = postgres(testConnection, { max: 1 });
    const db = createTenon({ connection: native });
    t.after(async () => {
      await db.close();
      await native.end({ timeout: 1 });
    });
    const query = (payload: object) => sql`SELECT ${payload}::jsonb AS payload`;
    // If execution starts preparing queries, this primes the cache and exposes the driver's pipeline bug.
    await db.query(query({ tag: 'warm' }));
    const results = await Promise.allSettled(
      [{ tag: 'first' }, { invalid: 1n }, { tag: 'third' }].map((payload) =>
        db.query(query(payload), { returns: 'one' }),
      ),
    );
    assert.deepEqual(results[0], { status: 'fulfilled', value: { payload: { tag: 'first' } } });
    assert.equal(results[1]!.status, 'rejected');
    if (results[1]!.status === 'rejected') assert.ok(results[1]!.reason instanceof TypeError);
    assert.deepEqual(results[2], { status: 'fulfilled', value: { payload: { tag: 'third' } } });
    assert.deepEqual(await db.query(query({ tag: 'after' }), { returns: 'one' }), {
      payload: { tag: 'after' },
    });
  },
);
