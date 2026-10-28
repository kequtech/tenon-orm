import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockDriver, result } from './helpers/driver.js';
import type { QueryEvent } from '../src/index.js';
import { AffectedRowsError, createTenon, identifier, sql, unsafeSql } from '../src/index.js';

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

test('fragments compose nested predicates with stable parameters and literal SQL', () => {
  const malicious = "x'); DELETE FROM users; --";
  const email = sql.fragment`email = ${malicious}`;
  const grouped = sql.fragment`(${email} OR id = ${7})`;
  const query = sql`SELECT '$1', $$literal $2$$, ${9} FROM ${identifier('User')}
    WHERE ${sql.join([grouped, sql.fragment`active = ${true}`], 'AND')}
    AND ${email} -- $10 stays a comment
    LIMIT ${3}`;
  assert.equal(
    query.text,
    `SELECT '$1', $$literal $2$$, $1 FROM "User"
    WHERE (email = $2 OR id = $3) AND active = $4
    AND email = $5 -- $10 stays a comment
    LIMIT $6`,
  );
  assert.deepEqual(query.values, [9, malicious, 7, true, malicious, 3]);
  assert.ok(Object.isFrozen(email));
  assert.ok(Object.isFrozen(query));
  assert.ok(Object.isFrozen(query.values));
  assert.equal(sql`SELECT ${'DESC'}`.text, 'SELECT $1');
  assert.equal(sql`SELECT 1 ORDER BY 1 ${sql.fragment`DESC`}`.text, 'SELECT 1 ORDER BY 1 DESC');
  const inputs = [email];
  const joined = sql.join(inputs, 'AND');
  inputs.push(sql.fragment`FALSE`);
  assert.equal(sql`SELECT 1 WHERE ${joined}`.text, 'SELECT 1 WHERE email = $1');
});

test('joins support only AND, OR and comma while preserving grouping and parameter order', () => {
  const alternatives = sql.join([sql.fragment`id = ${1}`, sql.fragment`id = ${2}`], 'OR');
  const predicate = sql.join(
    [sql.fragment`(${alternatives})`, sql.fragment`active = ${true}`],
    'AND',
  );
  const columns = sql.join([sql.fragment`${'a'}::text AS label`, sql.fragment`id`], ',');
  const query = sql`SELECT ${columns} FROM users WHERE ${predicate}`;
  assert.equal(
    query.text,
    'SELECT $1::text AS label, id FROM users WHERE (id = $2 OR id = $3) AND active = $4',
  );
  assert.deepEqual(query.values, ['a', 1, 2, true]);
  assert.equal(sql`SELECT ${sql.join([sql.fragment`${1}`], ',')}`.text, 'SELECT $1');
});

test('composition rejects empty lists, unsupported separators, executable queries and direct fragment execution', async () => {
  assert.throws(() => sql.join([], 'AND'), /at least one/);
  assert.throws(() => sql.fragment`  `, /must not be empty/);
  for (const separator of [
    ' AND ',
    'and',
    'UNION',
    'OR TRUE; --',
    '',
    undefined,
    null,
    sql.fragment` AND `,
  ]) {
    // @ts-expect-error JavaScript callers must also supply a supported separator
    assert.throws(() => sql.join([sql.fragment`TRUE`], separator), /separator must be/);
  }
  // @ts-expect-error values must be explicit fragments
  assert.throws(() => sql.join(['TRUE'], 'AND'), /Expected a fragment/);
  // @ts-expect-error executable statements cannot be used as fragments
  assert.throws(() => sql.join([sql`SELECT 1`], ','), /Expected a fragment/);
  assert.throws(() => sql.fragment`${sql`SELECT 1`}`, /Nested SQL/);
  assert.throws(() => sql.fragment`${unsafeSql('SELECT $1', [1])}`, /Nested SQL/);
  const db = createTenon({ connection: 'postgresql://unused' });
  try {
    // @ts-expect-error fragments cannot execute on their own
    await assert.rejects(db.query(sql.fragment`DELETE FROM users`), /Expected a query/);
  } finally {
    await db.close();
  }
});

test('diagnostics report metadata without SQL or values and cannot change query outcomes', async (t) => {
  const driverError = Object.assign(new Error('private details'), { code: '23505' });
  const { sql: pool } = mockDriver(t, async (text) => {
    if (text.includes('broken')) throw driverError;
    return result('SELECT', 1, [{ value: 7 }]);
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
