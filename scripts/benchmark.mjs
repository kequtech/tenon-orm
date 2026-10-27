import assert from 'node:assert/strict';
import postgres from 'postgres';
import { createTenon, sql } from '../dist/index.js';

const connection =
  process.env.TENON_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/tenon_orm_test';
const samples = 50;
let statements = 0;
const driver = postgres(connection, {
  max: 1,
  debug() {
    statements++;
  },
});
const db = createTenon({ connection: driver });
const results = [];
async function measure(name, work) {
  for (let i = 0; i < 5; i++) await work();
  const before = statements;
  const durations = [];
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    await work();
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  results.push({
    case: name,
    samples,
    statementsPerCall: (statements - before) / samples,
    p50Ms: +durations[Math.floor(samples * 0.5)].toFixed(3),
    p95Ms: +durations[Math.floor(samples * 0.95)].toFixed(3),
  });
}
try {
  assert.equal((await driver`SELECT current_database() AS name`)[0].name, 'tenon_orm_test');
  await driver`CREATE TEMP TABLE tenon_benchmark (id integer PRIMARY KEY, value integer NOT NULL)`;
  await driver`INSERT INTO tenon_benchmark VALUES (1,0)`;
  const statement = sql`UPDATE tenon_benchmark SET value=value+1 WHERE id=1`;
  await measure('postgres', () => driver.unsafe(statement.text, [...statement.values]));
  await measure('query', () => db.query(statement));
  await measure('query + affectedRows', () => db.query(statement, { affectedRows: { exact: 1 } }));
  await db.transaction(async (tx) => {
    await measure('transaction query', () => tx.query(statement));
    await measure('transaction query + affectedRows', () =>
      tx.query(statement, { affectedRows: { exact: 1 } }),
    );
  });
  console.log(
    JSON.stringify(
      {
        note: 'Sequential local microbenchmark. Transaction measurements exclude outer session acquisition, BEGIN and COMMIT; not a production performance guarantee.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await db.close();
  await driver.end();
}
