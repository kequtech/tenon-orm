import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { createTenon, sql, unsafeSql } from '../src/index.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const admin = new Pool({ connectionString: testConnection });
before(() => assertTestDatabase(admin));
after(() => admin.end());

test('compiled queries stay unnamed and retain native pg metadata', async (t) => {
  const db = createTenon({ connection: { connectionString: testConnection, max: 1 } });
  t.after(() => db.close());
  const query = unsafeSql(
    'SELECT $1::integer[] AS values, $2::jsonb AS payload, $3::bigint AS big',
    [[1, null, 3], JSON.stringify({ nested: ['one', null] }), 9007199254740993n],
  );
  for (const result of [
    await db.query(query),
    await db.query(query),
    await db.transaction((tx) => tx.query(query)),
  ]) {
    assert.deepEqual(result.rows, [
      { values: [1, null, 3], payload: { nested: ['one', null] }, big: '9007199254740993' },
    ]);
    assert.equal(result.rowCount, 1);
    assert.deepEqual(
      result.fields.map((f) => f.dataTypeID),
      [1007, 3802, 20],
    );
  }
  assert.deepEqual((await db.native.query('SELECT name FROM pg_prepared_statements')).rows, []);
});

test(
  'a JSON serialization failure preserves guarded transaction recovery',
  { timeout: 10000 },
  async (t) => {
    const native = new Pool({ connectionString: testConnection, max: 1 });
    const db = createTenon({ connection: native });
    t.after(async () => {
      await db.close();
      await native.end();
    });
    await native.query(`CREATE TEMP TABLE preparation_json (payload jsonb);
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
      [...(await native.query('SELECT * FROM preparation_json')).rows],
      [{ payload: { valid: true } }],
    );
    assert.deepEqual(
      [...(await native.query('SELECT * FROM preparation_audit')).rows],
      [{ value: 'kept' }],
    );
  },
);

test(
  'a concurrent serialization failure rejects its own query without shifting other results',
  { timeout: 10000 },
  async (t) => {
    const native = new Pool({ connectionString: testConnection, max: 1 });
    const db = createTenon({ connection: native });
    t.after(async () => {
      await db.close();
      await native.end();
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
