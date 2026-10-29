import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Temporal } from '@js-temporal/polyfill';
import { builtin, createPool, createTemporalCodecs, defaultCodecs } from '@kequtech/pgclear';
import { createTenon, describeQuery, sql } from '../src/index.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const pool = createPool(testConnection);
before(() => assertTestDatabase(pool));
after(() => pool.close());

test('Date, bigint and polyfilled Temporal inputs retain string output defaults through Tenon', async () => {
  const db = createTenon({ connection: pool });
  try {
    const date = new Date('2026-10-29T12:34:56.123Z');
    const day = Temporal.PlainDate.from('2026-10-29');
    const local = Temporal.PlainDateTime.from('2026-10-29T12:34:56.123456');
    const instant = Temporal.Instant.from('2026-10-29T12:34:56.123456Z');
    const time = Temporal.PlainTime.from('12:34:56.123456');
    const duration = Temporal.Duration.from('PT1H2M3S');
    const query = sql`SELECT ${date}::timestamptz AS date,
      ${9007199254740993n}::bigint AS big,
      ${day}::date AS day, ${local}::timestamp AS local,
      ${instant}::timestamptz AS instant, ${time}::time AS time,
      ${duration}::interval AS duration`;
    const expected = {
      date: '2026-10-29 12:34:56.123+00',
      big: '9007199254740993',
      day: '2026-10-29',
      local: '2026-10-29 12:34:56.123456',
      instant: '2026-10-29 12:34:56.123456+00',
      time: '12:34:56.123456',
      duration: 'PT1H2M3S',
    };
    assert.deepEqual(await db.query(query, { returns: 'one' }), expected);
    assert.deepEqual(await db.transaction((tx) => tx.query(query, { returns: 'one' })), expected);
    const described = await describeQuery({ connection: testConnection, query });
    assert.ok(described.columns.every(({ readType }) => readType === 'string'));
    await assert.rejects(db.query(sql`SELECT ${new Date(NaN)}::timestamptz`), {
      code: 'PGCLEAR_ENCODE',
    });
  } finally {
    await db.close();
  }
});

test('opt-in bigint, Date and Temporal output codecs agree with Describe and preserve defaults', async () => {
  const temporal = createTemporalCodecs(Temporal, {
    typescriptNamespace: 'import("@js-temporal/polyfill").Temporal',
  });
  const codecs = defaultCodecs
    .with(builtin.int8BigInt)
    .with(builtin.timestamptzDate)
    .with(temporal.date)
    .with(temporal.timestamp);
  const native = createPool({ connectionString: testConnection, codecs });
  const db = createTenon({ connection: native });
  const query = sql`SELECT ${9007199254740993n}::bigint AS big,
    ${new Date('2026-10-29T12:34:56.123Z')}::timestamptz AS date,
    ${Temporal.PlainDate.from('2026-10-29')}::date AS day,
    ${Temporal.PlainDateTime.from('2026-10-29T12:34:56.123456')}::timestamp AS local`;
  try {
    const row = await db.query(query, { returns: 'one' });
    assert.equal(row.big, 9007199254740993n);
    assert.ok(row.date instanceof Date);
    assert.equal(row.date.toISOString(), '2026-10-29T12:34:56.123Z');
    assert.ok(row.day instanceof Temporal.PlainDate);
    assert.equal(row.day.toString(), '2026-10-29');
    assert.ok(row.local instanceof Temporal.PlainDateTime);
    assert.equal(row.local.toString(), '2026-10-29T12:34:56.123456');
    const description = await describeQuery({ connection: testConnection, query, codecs });
    assert.deepEqual(
      description.columns.map(({ readType }) => readType),
      [
        'bigint',
        'globalThis.Date',
        'import("@js-temporal/polyfill").Temporal.PlainDate',
        'import("@js-temporal/polyfill").Temporal.PlainDateTime',
      ],
    );
    assert.deepEqual((await pool.queryClassic('SELECT 42::bigint AS value')).rows, [
      { value: '42' },
    ]);
    await db.close();
    assert.deepEqual((await native.queryClassic('SELECT 43::bigint AS value')).rows, [
      { value: 43n },
    ]);
  } finally {
    await db.close();
    await native.close();
  }
});
