import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { parseArgs } from 'node:util';
import { createPool } from '@kequtech/pgclear';
import { createTenon, sql } from '../dist/index.js';

const { values } = parseArgs({
  options: {
    samples: { type: 'string', default: '500' },
    repetitions: { type: 'string', default: '5' },
  },
});
const samples = Number(values.samples);
const repetitions = Number(values.repetitions);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100_000)
  throw new Error('samples must be an integer between 1 and 100000.');
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 25)
  throw new Error('repetitions must be an integer between 1 and 25.');
const warmup = 50;
const connection =
  process.env.TENON_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/tenon_orm_test';
const driver = createPool({ connectionString: connection, maxConnections: 1 });
const db = createTenon({ connection: driver });
const measurements = [];
const root = new URL('../', import.meta.url);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return { min: sorted[0], median: rank(0.5), p95: rank(0.95), max: sorted.at(-1) };
}

// Hash the executed code as well as recording package versions; builds can differ at one version.
async function codeHash(directory) {
  const hash = createHash('sha256');
  async function visit(at, prefix = '') {
    const entries = (await readdir(at, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    );
    for (const entry of entries) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await visit(new URL(entry.name + '/', at), path + '/');
      else if (entry.name.endsWith('.js')) {
        hash.update(path + '\0');
        hash.update(await readFile(new URL(entry.name, at)));
        hash.update('\0');
      }
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

try {
  const {
    rows: [database],
  } = await driver.queryClassic(
    "SELECT current_database() AS name, current_setting('server_version') AS version",
    [],
  );
  assert.equal(database.name, 'tenon_orm_test');
  const driverRoot = new URL('../', import.meta.resolve('@kequtech/pgclear'));
  const [tenonPackage, driverPackage] = await Promise.all([
    readFile(new URL('package.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('package.json', driverRoot), 'utf8').then(JSON.parse),
  ]);
  const evidence = {
    recordedAt: new Date().toISOString(),
    revision: git('rev-parse', 'HEAD'),
    workingTreeDirty: !!git('status', '--porcelain'),
    harnessSha256: createHash('sha256')
      .update(await readFile(new URL(import.meta.url)))
      .digest('hex'),
    versions: { tenon: tenonPackage.version, pgclear: driverPackage.version },
    codeSha256: {
      tenon: await codeHash(new URL('dist/', root)),
      pgclear: await codeHash(new URL('dist/', driverRoot)),
    },
    node: process.version,
    postgres: database.version,
    machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model },
    config: { samples, repetitions, warmup, maxConnections: 1, transport: 'direct' },
  };
  await driver.queryClassic(
    'CREATE TEMP TABLE tenon_benchmark (id integer PRIMARY KEY, value integer NOT NULL)',
    [],
  );
  await driver.queryClassic('INSERT INTO tenon_benchmark VALUES (1,0)', []);
  await driver.queryClassic('CREATE TEMP TABLE tenon_benchmark_log (value integer NOT NULL)', []);
  const update = sql`UPDATE tenon_benchmark SET value=value+${1}::integer WHERE id=${1}::integer`;
  const read = sql`SELECT value FROM tenon_benchmark WHERE id=${1}::integer FOR UPDATE`;
  const insert = sql`INSERT INTO tenon_benchmark_log (value) VALUES (${1}::integer)`;
  const batch = sql`INSERT INTO tenon_benchmark_log ${sql.insertValues(
    Array.from({ length: 10 }, () => ({ value: 1 })),
  )}`;
  const nativeQuery = (client, query) => client.queryClassic(query.text, query.values);
  const cases = [
    {
      name: 'pgclear: unprepared query',
      updates: 1,
      inserts: 0,
      work: () => nativeQuery(driver, update),
    },
    { name: 'tenon: query', updates: 1, inserts: 0, work: () => db.query(update) },
    {
      name: 'tenon: guarded write',
      updates: 1,
      inserts: 0,
      work: () => db.query(update, { affectedRows: { exact: 1 } }),
    },
    {
      name: 'pgclear: empty transaction',
      updates: 0,
      inserts: 0,
      work: () => driver.transaction(async () => {}),
    },
    {
      name: 'tenon: empty transaction',
      updates: 0,
      inserts: 0,
      work: () => db.transaction(async () => {}),
    },
    {
      name: 'pgclear: one-query transaction',
      updates: 1,
      inserts: 0,
      work: () => driver.transaction((tx) => nativeQuery(tx, update)),
    },
    {
      name: 'tenon: one-query transaction',
      updates: 1,
      inserts: 0,
      work: () => db.transaction((tx) => tx.query(update)),
    },
    {
      name: 'pgclear: three-query transaction',
      updates: 1,
      inserts: 1,
      work: () =>
        driver.transaction(async (tx) => {
          for (const query of [read, update, insert]) await nativeQuery(tx, query);
        }),
    },
    {
      name: 'tenon: three-query transaction',
      updates: 1,
      inserts: 1,
      work: () =>
        db.transaction(async (tx) => {
          for (const query of [read, update, insert]) await tx.query(query);
        }),
    },
    {
      name: 'tenon: three-query transaction with write guards',
      updates: 1,
      inserts: 1,
      work: () =>
        db.transaction(async (tx) => {
          await tx.query(read);
          for (const query of [update, insert])
            await tx.query(query, { affectedRows: { exact: 1 } });
        }),
    },
    {
      name: 'tenon: ten separate inserts in one transaction',
      updates: 0,
      inserts: 10,
      work: () =>
        db.transaction(async (tx) => {
          for (let i = 0; i < 10; i++) await tx.query(insert);
        }),
    },
    {
      name: 'tenon: one batch of ten inserts in one transaction',
      updates: 0,
      inserts: 10,
      work: () => db.transaction((tx) => tx.query(batch)),
    },
  ];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    // Rotate the first case so each comparison is not always measured in the same order.
    const ordered = cases.map((_, i) => cases[(i + repetition) % cases.length]);
    for (const { name, work } of ordered) {
      for (let i = 0; i < warmup; i++) await work();
      const durations = [];
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      for (let i = 0; i < samples; i++) {
        const before = performance.now();
        await work();
        durations.push(performance.now() - before);
      }
      const elapsedMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuStart);
      measurements.push({
        case: name,
        repetition,
        operations: samples,
        elapsedMs,
        operationsPerSecond: (samples / elapsedMs) * 1000,
        latencyMs: summarize(durations),
        clientCpuMs: (cpu.user + cpu.system) / 1000,
      });
    }
  }
  const totalRuns = repetitions * (samples + warmup);
  const state = (await driver.queryClassic('SELECT value FROM tenon_benchmark', [])).rows[0];
  assert.equal(state.value, cases.reduce((sum, item) => sum + item.updates, 0) * totalRuns);
  const count = (
    await driver.queryClassic('SELECT count(*)::integer AS count FROM tenon_benchmark_log', [])
  ).rows[0];
  assert.equal(count.count, cases.reduce((sum, item) => sum + item.inserts, 0) * totalRuns);
  const summaries = cases.map(({ name }) => {
    const selected = measurements.filter((item) => item.case === name);
    return {
      case: name,
      operationsPerSecond: summarize(selected.map((item) => item.operationsPerSecond)),
      medianLatencyMs: summarize(selected.map((item) => item.latencyMs.median)),
      p95LatencyMs: summarize(selected.map((item) => item.latencyMs.p95)),
      clientCpuMs: summarize(selected.map((item) => item.clientCpuMs)),
    };
  });
  console.log(
    JSON.stringify(
      {
        ...evidence,
        notes: [
          'Sequential direct local measurements on a warm single-connection pool; unnamed extended queries.',
          'Each sample measures one query or whole transaction, including acquisition, BEGIN and COMMIT.',
          'Queries/fragments are constructed before timing. Warmup, setup, code hashing and final row assertions are excluded.',
          'Temporary tables do not represent durable business-table writes or production capacity.',
          'Summaries are medians/ranges across repetitions, not pooled latency distributions. CPU excludes PostgreSQL.',
        ],
        measurements,
        summaries,
      },
      null,
      2,
    ),
  );
} finally {
  await db.close();
  await driver.close();
}
