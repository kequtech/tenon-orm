import assert from 'node:assert/strict';
import postgres from 'postgres';
import { createTenon, sql } from '../dist/index.js';

const connection =
  process.env.TENON_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/tenon_orm_test';
const samples = 100;
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
  const [database] =
    await driver`SELECT current_database() AS name, current_setting('server_version') AS version`;
  assert.equal(database.name, 'tenon_orm_test');
  await driver`CREATE TEMP TABLE tenon_benchmark (id integer PRIMARY KEY, value integer NOT NULL)`;
  await driver`INSERT INTO tenon_benchmark VALUES (1,0)`;
  await driver`CREATE TEMP TABLE tenon_benchmark_log (value integer NOT NULL)`;
  const update = sql`UPDATE tenon_benchmark SET value=value+${1}::integer WHERE id=${1}::integer`;
  const read = sql`SELECT value FROM tenon_benchmark WHERE id=${1}::integer FOR UPDATE`;
  const insert = sql`INSERT INTO tenon_benchmark_log (value) VALUES (${1}::integer)`;
  const batch = sql`INSERT INTO tenon_benchmark_log ${sql.insertValues(
    Array.from({ length: 10 }, () => ({ value: 1 })),
  )}`;
  const nativeQuery = (client, query, prepare = false) =>
    client.unsafe(query.text, [...query.values], { simple: false, prepare });
  await measure('postgres: unprepared query', () => nativeQuery(driver, update));
  await measure('postgres: prepared query', () => nativeQuery(driver, update, true));
  await measure('tenon: query', () => db.query(update));
  await measure('tenon: guarded write', () => db.query(update, { affectedRows: { exact: 1 } }));
  await measure('postgres: empty transaction', () => driver.begin(async () => {}));
  await measure('tenon: empty transaction', () => db.transaction(async () => {}));
  await measure('postgres: one-query transaction', () =>
    driver.begin((tx) => nativeQuery(tx, update)),
  );
  await measure('tenon: one-query transaction', () => db.transaction((tx) => tx.query(update)));
  await measure('postgres: prepared one-query transaction', () =>
    driver.begin((tx) => nativeQuery(tx, update, true)),
  );
  await measure('postgres: three-query transaction', () =>
    driver.begin(async (tx) => {
      for (const query of [read, update, insert]) await nativeQuery(tx, query);
    }),
  );
  await measure('tenon: three-query transaction', () =>
    db.transaction(async (tx) => {
      for (const query of [read, update, insert]) await tx.query(query);
    }),
  );
  await measure('postgres: prepared three-query transaction', () =>
    driver.begin(async (tx) => {
      for (const query of [read, update, insert]) await nativeQuery(tx, query, true);
    }),
  );
  await measure('tenon: three-query transaction with write guards', () =>
    db.transaction(async (tx) => {
      await tx.query(read);
      for (const query of [update, insert]) await tx.query(query, { affectedRows: { exact: 1 } });
    }),
  );
  await measure('tenon: ten separate inserts in one transaction', () =>
    db.transaction(async (tx) => {
      for (let i = 0; i < 10; i++) await tx.query(insert);
    }),
  );
  await measure('tenon: one batch of ten inserts in one transaction', () =>
    db.transaction((tx) => tx.query(batch)),
  );
  console.log(
    JSON.stringify(
      {
        node: process.version,
        postgres: database.version,
        note: 'Sequential local measurements on a warm max:1 pool. Transactions include reservation, bootstrap, BEGIN and COMMIT. Statements are SQL dispatches, not protocol round trips. Native transaction cases use unprepared body queries unless labelled prepared; native begin retains its own control-statement behavior. Tenon uses its normal preparation policy. Results are not a production performance guarantee.',
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
