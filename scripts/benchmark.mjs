import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createTenon, sql } from '../dist/index.js';

const connectionString =
  process.env.TENON_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/tenon_orm_test';
const samples = 50;
const results = [];
for (const latencyMs of [0, 5]) {
  const pool = new Pool({ connectionString, max: 1 });
  let statements = 0;
  pool.on('connect', (client) => {
    const original = client.query.bind(client);
    client.query = (...args) => {
      statements++;
      if (!latencyMs) return original(...args);
      if (typeof args.at(-1) === 'function') {
        void delay(latencyMs).then(() => original(...args));
        return;
      }
      return delay(latencyMs).then(() => original(...args));
    };
  });
  const db = createTenon({ connection: pool });
  try {
    assert.equal(
      (await pool.query('SELECT current_database() AS name')).rows[0].name,
      'tenon_orm_test',
    );
    await pool.query(
      'CREATE TEMP TABLE tenon_benchmark (id integer PRIMARY KEY, value integer NOT NULL)',
    );
    await pool.query('INSERT INTO tenon_benchmark VALUES (1,0)');
    const statement = sql`UPDATE tenon_benchmark SET value=value+1 WHERE id=1`;
    const cases = [
      ['pg', async () => pool.query(statement.text, [...statement.values])],
      ['query', async () => db.query(statement)],
      ['query + affectedRows', async () => db.query(statement, { affectedRows: { exact: 1 } })],
    ];
    async function measure(name, work) {
      for (let i = 0; i < 5; i++) await work();
      const before = statements;
      const durations = [];
      for (let i = 0; i < samples; i++) {
        const start = performance.now();
        await work();
        durations.push(performance.now() - start);
      }
      durations.sort((a, b) => a - b);
      results.push({
        latencyMs,
        case: name,
        samples,
        statementsPerCall: (statements - before) / samples,
        p50Ms: +durations[Math.floor(samples * 0.5)].toFixed(3),
        p95Ms: +durations[Math.floor(samples * 0.95)].toFixed(3),
      });
    }
    for (const [name, work] of cases) await measure(name, work);
    await db.transaction(async (tx) => {
      await measure('transaction query', () => tx.query(statement));
      await measure('transaction query + affectedRows', () =>
        tx.query(statement, { affectedRows: { exact: 1 } }),
      );
    });
  } finally {
    await db.close();
    await pool.end();
  }
}
console.log(
  JSON.stringify(
    {
      note: 'Sequential local microbenchmark; latencyMs adds a simulated delay per driver query, not a real network. Transaction measurements exclude outer BEGIN/COMMIT.',
      results,
    },
    null,
    2,
  ),
);
