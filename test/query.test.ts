import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { QueryEvent } from '../src/index.js';
import {
  AffectedRowsError,
  createTenon,
  defineOperation,
  identifier,
  sql,
  unsafeSql,
} from '../src/index.js';

test('templates bind values, preserve order and quote identifiers explicitly', () => {
  const malicious = "x'); DELETE FROM users; --";
  const query = sql`SELECT * FROM ${identifier('odd"schema', 'User')}
    WHERE email = ${malicious} AND id = ${4} OR id = ${4}`;
  assert.equal(
    query.text,
    'SELECT * FROM "odd""schema"."User"\n    WHERE email = $1 AND id = $2 OR id = $3',
  );
  assert.deepEqual(query.values, [malicious, 4, 4]);
  assert.ok(Object.isFrozen(query));
  assert.ok(Object.isFrozen(query.values));
  assert.equal(sql`SELECT ${'User'}`.text, 'SELECT $1');
  assert.throws(() => identifier(), /at least one/);
  assert.throws(() => identifier('bad\0name'), /Identifiers/);
  assert.throws(() => sql`SELECT ${sql`SELECT 1`}`, /Nested SQL/);
  const input = [1];
  const external = unsafeSql('SELECT $1', input);
  input[0] = 2;
  assert.deepEqual(external.values, [1]);
});

test('query factories are lazy and errors in factories propagate without dispatch', async (t) => {
  const pool = new Pool();
  const query = t.mock.method(pool, 'query', async () => {
    throw new Error('unexpected dispatch');
  });
  const db = createTenon({ connection: pool });
  const failure = new Error('factory failed');
  const operation = defineOperation(() => {
    throw failure;
  });
  try {
    await assert.rejects(db.run(operation, []), (error) => error === failure);
    assert.equal(query.mock.callCount(), 0);
  } finally {
    await db.close();
    await pool.end();
  }
});

test('diagnostics report metadata without SQL or values and cannot change query outcomes', async (t) => {
  const pool = new Pool();
  const driverError = Object.assign(new Error('private details'), { code: '23505' });
  t.mock.method(pool, 'query', async (config: { text: string }) => {
    if (config.text.includes('broken')) throw driverError;
    return { command: 'SELECT', rowCount: 1, rows: [{ value: 7 }], fields: [], oid: 0 };
  });
  const events: QueryEvent[] = [];
  const db = createTenon({
    connection: pool,
    onQuery: (event) => {
      events.push(event);
    },
  });
  try {
    assert.deepEqual(
      await db.query(sql<{ value: number }>`SELECT ${'secret'} AS value`, {
        returns: 'one',
        label: 'lookup',
      }),
      { value: 7 },
    );
    await assert.rejects(db.query(sql`SELECT broken`), (error) => error === driverError);
    assert.equal(events[0]!.outcome, 'success');
    assert.equal(events[0]!.label, 'lookup');
    assert.equal(events[0]!.rowCount, 1);
    assert.ok(events[0]!.durationMs >= 0);
    assert.equal(events[1]!.errorCode, '23505');
    assert.equal(events[1]!.outcome, 'error');
    assert.ok(!JSON.stringify(events).includes('secret'));
    assert.ok(!JSON.stringify(events).includes('private details'));
    assert.ok(!('text' in events[0]!));
    assert.ok(Object.isFrozen(events[0]));
    const warnings = t.mock.method(process, 'emitWarning', () => {});
    for (const onQuery of [
      () => {
        throw new Error('observer');
      },
      async () => {
        throw new Error('observer');
      },
    ]) {
      const observed = createTenon({ connection: pool, onQuery });
      assert.equal((await observed.query(sql`SELECT 1`)).rowCount, 1);
      await new Promise((resolve) => setImmediate(resolve));
      await observed.close();
    }
    assert.equal(warnings.mock.callCount(), 2);
  } finally {
    await db.close();
    await pool.end();
  }
});

test('affected-row errors expose immutable expectations, native counts and stable codes', () => {
  const mismatch = new AffectedRowsError({ exact: 1 }, 2, 'UPDATE', true);
  assert.equal(mismatch.code, 'TENON_AFFECTED_ROWS_MISMATCH');
  assert.deepEqual(mismatch.expected, { exact: 1 });
  assert.equal(mismatch.actual, 2);
  assert.equal(mismatch.command, 'UPDATE');
  assert.ok(Object.isFrozen(mismatch.expected));
  const unsupported = new AffectedRowsError({ max: 1 }, null, 'CREATE', false);
  assert.equal(unsupported.code, 'TENON_AFFECTED_ROWS_UNSUPPORTED');
  assert.equal(unsupported.actual, null);
});
