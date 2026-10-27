import { assertInvalidDate } from './helpers/values.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { createTenon, describeQuery, identifier, migrate, sql, unsafeSql } from '../src/index.js';
import type { SqlQuery, UnknownRow } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const pool = postgres(testConnection);
const project = migrationProject(pool);
const run = promisify(execFile);
before(() => assertTestDatabase(pool));
after(() => pool.end());

const schema = `
  CREATE TYPE mood AS ENUM ('ready', 'waiting');
  CREATE DOMAIN exact_count AS bigint CHECK (VALUE >= 0);
  CREATE TABLE accounts (
    id integer PRIMARY KEY, name text NOT NULL, optional text,
    quota bigint NOT NULL, amount numeric NOT NULL, payload jsonb NOT NULL,
    at timestamptz NOT NULL, tags text[] NOT NULL, amounts numeric[] NOT NULL,
    state mood NOT NULL, counter exact_count NOT NULL
  );
  CREATE TABLE messages (
    id integer PRIMARY KEY, account_id integer REFERENCES accounts(id), bytes integer NOT NULL
  );
  CREATE SEQUENCE probe_sequence;
  CREATE FUNCTION double_value(value integer) RETURNS integer LANGUAGE sql IMMUTABLE
    AS 'SELECT value * 2';
  CREATE VIEW account_names AS SELECT id, name FROM accounts;
  INSERT INTO accounts VALUES
    (1, 'Ada', NULL, 9007199254740993, 1.25, '{"name":"Ada"}', '2026-01-01T00:00:00Z',
      ARRAY['a',NULL], ARRAY[1.25,NULL], 'ready', 10),
    (2, 'Bea', 'present', 20, 2.5, 'null', 'infinity',
      ARRAY['b'], ARRAY[2.5], 'waiting', 20);
  INSERT INTO messages VALUES (1,1,10), (2,1,20), (3,NULL,5);
`;

async function fixture(work: (namespace: string) => Promise<void>): Promise<void> {
  await project({ '0001_schema.up.sql': schema }, async (options) => {
    await migrate(options);
    await work(options.namespace);
  });
}

function raw(text: string, values: readonly unknown[] = []): SqlQuery {
  return unsafeSql(text, values);
}

function describe(query: string | SqlQuery) {
  return describeQuery({ connection: testConnection, query });
}

async function execute(query: SqlQuery): Promise<UnknownRow[]> {
  const db = createTenon({ connection: pool });
  try {
    return await db.query(query, { returns: 'many' });
  } finally {
    await db.close();
  }
}

test('Describe validates projections, parameters and PostgreSQL errors even when no rows match', async () => {
  await fixture(async (namespace) => {
    const accounts = identifier(namespace, 'accounts');
    const query = sql`SELECT id, name, optional FROM ${accounts} WHERE id = ${999}`;
    const result = await describe(query);
    assert.deepEqual(
      result.parameters.map((p) => p.postgres),
      ['pg_catalog.int4'],
    );
    assert.deepEqual(
      result.columns.map((c) => [c.name, c.readType]),
      [
        ['id', 'number'],
        ['name', 'string'],
        ['optional', 'string'],
      ],
    );
    assert.deepEqual(
      result.columns.map((c) => c.source?.notNull),
      [true, true, false],
    );
    assert.ok(result.columns.every((c) => c.nullability === 'unknown'));
    assert.deepEqual(await execute(query), []);
    const errors = [
      [sql`SELECT missing FROM ${accounts}`, '42703'],
      [sql`SELECT * FROM ${identifier(namespace, 'missing')}`, '42P01'],
      [sql`SELECT id + true FROM ${accounts}`, '42883'],
      [raw('SELEC broken'), '42601'],
      [raw('SELECT $1 IS NULL', [null]), '42P18'],
      [raw('SELECT 1; SELECT 2'), '42601'],
    ] as const;
    for (const [statement, code] of errors) {
      await assert.rejects(describe(statement), { code });
    }
    assert.equal((await describe('SELECT 1 AS recovered')).columns[0]!.readType, 'number');
  });
});

test('all join directions and a self join expose why source NOT NULL is not result nullability', async () => {
  await fixture(async (namespace) => {
    const a = qualified(namespace, 'accounts');
    const m = qualified(namespace, 'messages');
    for (const [kind, expected] of [
      [
        'INNER',
        [
          { account: 1, message: 1 },
          { account: 1, message: 2 },
        ],
      ],
      [
        'LEFT',
        [
          { account: 1, message: 1 },
          { account: 1, message: 2 },
          { account: 2, message: null },
        ],
      ],
      [
        'RIGHT',
        [
          { account: 1, message: 1 },
          { account: 1, message: 2 },
          { account: null, message: 3 },
        ],
      ],
      [
        'FULL',
        [
          { account: 1, message: 1 },
          { account: 1, message: 2 },
          { account: 2, message: null },
          { account: null, message: 3 },
        ],
      ],
    ] as const) {
      const query = raw(`SELECT a.id AS account, m.id AS message FROM ${a} a
        ${kind} JOIN ${m} m ON m.account_id = a.id ORDER BY account NULLS LAST, message NULLS LAST`);
      const result = await describe(query);
      assert.deepEqual(
        result.columns.map((c) => [c.readType, c.source?.notNull, c.nullability]),
        [
          ['number', true, 'unknown'],
          ['number', true, 'unknown'],
        ],
      );
      assert.deepEqual(await execute(query), expected);
    }
    const self = raw(`SELECT a.name AS required, b.name AS absent
      FROM ${a} a LEFT JOIN ${a} b ON false WHERE a.id = 1`);
    const result = await describe(self);
    assert.deepEqual(result.columns[0]!.source, result.columns[1]!.source);
    assert.deepEqual(await execute(self), [{ required: 'Ada', absent: null }]);
    assert.ok(result.issues.some((issue) => issue.code === 'nullability-unknown'));
  });
});

test('COUNT, SUM, COALESCE, CASE and functions have accurate base types but unknown nullability', async () => {
  await fixture(async (namespace) => {
    const accounts = qualified(namespace, 'accounts');
    const messages = qualified(namespace, 'messages');
    const cases: { query: SqlQuery; types: string[]; rows: UnknownRow[] }[] = [
      {
        query: raw(`SELECT count(*) AS n, sum(bytes) AS total FROM ${messages}`),
        types: ['string', 'string'],
        rows: [{ n: '3', total: '35' }],
      },
      {
        query: raw(`SELECT count(*) AS n, sum(bytes) AS total FROM ${messages} WHERE false`),
        types: ['string', 'string'],
        rows: [{ n: '0', total: null }],
      },
      {
        query: raw(`SELECT coalesce(sum(bytes),0) AS total FROM ${messages} WHERE false`),
        types: ['string'],
        rows: [{ total: '0' }],
      },
      {
        query: raw(`SELECT CASE WHEN id = 1 THEN name END AS name FROM ${accounts} ORDER BY id`),
        types: ['string'],
        rows: [{ name: 'Ada' }, { name: null }],
      },
      {
        query: raw(
          `SELECT ${qualified(namespace, 'double_value')}(id) AS doubled FROM ${accounts} ORDER BY id`,
        ),
        types: ['number'],
        rows: [{ doubled: 2 }, { doubled: 4 }],
      },
      {
        query: sql`SELECT pg_catalog.current_schema() AS schema, pg_try_advisory_xact_lock(hashtextextended(${'describe-test'},0)) AS locked`,
        types: ['string', 'boolean'],
        rows: [{ schema: 'public', locked: true }],
      },
      {
        query: sql`SELECT pg_try_advisory_xact_lock(NULL::bigint) AS locked`,
        types: ['boolean'],
        rows: [{ locked: null }],
      },
    ];
    for (const example of cases) {
      const result = await describe(example.query);
      assert.deepEqual(
        result.columns.map((c) => c.readType),
        example.types,
      );
      assert.ok(result.columns.every((c) => c.nullability === 'unknown'));
      assert.deepEqual(await execute(example.query), example.rows);
    }
  });
});

test('a composed CTE, lateral join, window and JSON query describes the exact SQL the agent will execute', async () => {
  await fixture(async (namespace) => {
    const accounts = identifier(namespace, 'accounts');
    const messages = identifier(namespace, 'messages');
    function ownership(id: number) {
      return sql.fragment`a.id >= ${id}`;
    }
    function build(minimum: number, onlyReady: boolean) {
      const conditions = [ownership(minimum)];
      if (onlyReady) conditions.push(sql.fragment`a.state = ${'ready'}`);
      return sql`WITH totals AS (
          SELECT account_id, count(*) AS messages, sum(bytes) AS bytes
          FROM ${messages} GROUP BY account_id
        )
        SELECT a.id, a.name, coalesce(t.messages,0) AS messages, coalesce(t.bytes,0) AS bytes,
          latest.id AS latest, dense_rank() OVER (ORDER BY a.id) AS rank,
          jsonb_build_object('name',a.name,'messages',coalesce(t.messages,0)) AS summary
        FROM ${accounts} a LEFT JOIN totals t ON t.account_id = a.id
        LEFT JOIN LATERAL (SELECT id FROM ${messages} WHERE account_id = a.id
          ORDER BY id DESC LIMIT 1) latest ON true
        WHERE ${sql.join(conditions, 'AND')} ORDER BY a.id`;
    }
    for (const ready of [true, false]) {
      const query = build(1, ready);
      const result = await describe(query);
      assert.deepEqual(
        result.columns.map((c) => c.readType),
        ['number', 'string', 'string', 'string', 'number', 'string', 'unknown'],
      );
      assert.deepEqual(
        result.parameters.map((p) => p.postgres),
        ready ? ['pg_catalog.int4', `${namespace}.mood`] : ['pg_catalog.int4'],
      );
      const rows = await execute(query);
      assert.deepEqual(rows[0], {
        id: 1,
        name: 'Ada',
        messages: '2',
        bytes: '30',
        latest: 2,
        rank: '1',
        summary: { name: 'Ada', messages: 2 },
      });
      assert.equal(rows.length, ready ? 1 : 2);
      if (!ready)
        assert.deepEqual(rows[1], {
          id: 2,
          name: 'Bea',
          messages: '0',
          bytes: '0',
          latest: null,
          rank: '2',
          summary: { name: 'Bea', messages: 0 },
        });
    }
  });
});

test('recursive CTEs, UNION, views and grouping sets do not need a client SQL parser', async () => {
  await fixture(async (namespace) => {
    const cases: { query: SqlQuery; rows: UnknownRow[]; types: string[] }[] = [
      {
        query:
          raw(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<3)
          SELECT n FROM numbers ORDER BY n`),
        rows: [{ n: 1 }, { n: 2 }, { n: 3 }],
        types: ['number'],
      },
      {
        query: raw(
          `SELECT name FROM ${qualified(namespace, 'accounts')} WHERE id=1 UNION ALL SELECT NULL`,
        ),
        rows: [{ name: 'Ada' }, { name: null }],
        types: ['string'],
      },
      {
        query: raw(`SELECT name FROM ${qualified(namespace, 'account_names')} ORDER BY id`),
        rows: [{ name: 'Ada' }, { name: 'Bea' }],
        types: ['string'],
      },
      {
        query: raw(`SELECT name, count(*) AS n FROM ${qualified(namespace, 'accounts')}
          GROUP BY GROUPING SETS ((name),()) ORDER BY name NULLS LAST`),
        rows: [
          { name: 'Ada', n: '1' },
          { name: 'Bea', n: '1' },
          { name: null, n: '2' },
        ],
        types: ['string', 'string'],
      },
    ];
    for (const example of cases) {
      const result = await describe(example.query);
      assert.deepEqual(
        result.columns.map((c) => c.readType),
        example.types,
      );
      assert.deepEqual(await execute(example.query), example.rows);
      assert.ok(result.columns.every((c) => c.nullability === 'unknown'));
    }
  });
});

test('described mappings agree with Postgres.js for precision, JSON, dates, arrays, enums and domains', async () => {
  await fixture(async (namespace) => {
    const query = sql`SELECT quota, amount, payload, at, tags, amounts, state, counter
      FROM ${identifier(namespace, 'accounts')} ORDER BY id`;
    const result = await describe(query);
    assert.deepEqual(
      result.columns.map((c) => c.readType),
      [
        'string',
        'string',
        'unknown',
        'globalThis.Date',
        'PgArray<string>',
        'PgArray<string>',
        '"ready" | "waiting"',
        'string',
      ],
    );
    const rows = await execute(query);
    assert.deepEqual(rows[0], {
      quota: '9007199254740993',
      amount: '1.25',
      payload: { name: 'Ada' },
      at: new Date('2026-01-01T00:00:00Z'),
      tags: ['a', null],
      amounts: ['1.25', null],
      state: 'ready',
      counter: '10',
    });
    assert.ok(rows[1]!.at instanceof Date && Number.isNaN(rows[1]!.at.getTime()));
    assert.equal(rows[1]!.payload, null);
    const arrays = sql`SELECT ARRAY[[1,NULL],[2,3]]::integer[] AS matrix,
      ARRAY[9007199254740993,NULL]::bigint[] AS big,
      ARRAY['2026-01-01T00:00:00Z','infinity',NULL]::timestamptz[] AS dates,
      decode('00ff','hex') AS bytes,
      ARRAY['{"name":"Ada"}','null']::jsonb[] AS documents`;
    const mapped = await describe(arrays);
    assert.deepEqual(
      mapped.columns.map((c) => c.readType),
      [
        'PgArray<number>',
        'PgArray<string>',
        'PgArray<globalThis.Date>',
        'import("node:buffer").Buffer',
        'PgArray<unknown>',
      ],
    );
    const arrayRows = await execute(arrays);
    const invalid = (arrayRows[0]!.dates as unknown[])[1];
    assertInvalidDate(invalid);
    assert.deepEqual(arrayRows, [
      {
        matrix: [
          [1, null],
          [2, 3],
        ],
        big: ['9007199254740993', null],
        dates: [new Date('2026-01-01T00:00:00Z'), invalid, null],
        bytes: Buffer.from([0, 255]),
        documents: [{ name: 'Ada' }, null],
      },
    ]);
    assert.ok(
      mapped.issues.some(
        (issue) => issue.code === 'shape-unknown' && issue.columns.includes('documents'),
      ),
    );
    assert.ok(result.issues.some((issue) => issue.code === 'shape-unknown'));
  });
});

test('date and timestamp scalars preserve Postgres.js finite and invalid dates', async () => {
  const query = sql`SELECT DATE '2026-01-01' AS day, DATE 'infinity' AS infinite_day,
    TIMESTAMP '2026-01-01 12:30:00' AS local, TIMESTAMP '-infinity' AS infinite_local,
    TIMESTAMPTZ '2026-01-01T00:00:00Z' AS instant`;
  const result = await describe(query);
  assert.ok(result.columns.every((c) => c.readType === 'globalThis.Date'));
  const [row] = await execute(query);
  for (const name of ['day', 'local', 'instant']) {
    assert.ok(row![name] instanceof Date);
    assert.ok(Number.isFinite(row![name].getTime()));
  }
  assert.ok(row!.infinite_day instanceof Date && Number.isNaN(row!.infinite_day.getTime()));
  assert.ok(row!.infinite_local instanceof Date && Number.isNaN(row!.infinite_local.getTime()));
  assert.deepEqual(row!.instant, new Date('2026-01-01T00:00:00Z'));
});

test('the conservative declaration compiles under TypeScript 6 and 7 without claiming non-null or JSON structure', async () => {
  await fixture(async (namespace) => {
    const result = await describe(sql`SELECT quota, payload, state, tags, amounts, at,
      decode('00ff','hex') AS bytes FROM ${identifier(namespace, 'accounts')}`);
    const directory = await mkdtemp(join(tmpdir(), 'tenon-described-types-'));
    try {
      await writeFile(
        join(directory, 'consumer.ts'),
        `${result.rowType}
        declare const row: DescribedRow;
        const quota: string | null = row.quota;
        const state: 'ready' | 'waiting' | null = row.state;
        const tags: PgArray<string> | null = row.tags;
        const amounts: PgArray<string> | null = row.amounts;
        const at: Date | null = row.at;
        const bytes: import('node:buffer').Buffer | null = row.bytes;
        // @ts-expect-error Describe cannot establish a non-null result
        const assumed: string = row.quota;
        // @ts-expect-error PostgreSQL's JSON type does not verify an object shape
        const payload: { name: string } = row.payload;
        `,
      );
      const config = join(directory, 'tsconfig.json');
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            target: 'ES2022',
            module: 'NodeNext',
            types: ['node'],
            typeRoots: [resolve('node_modules/@types')],
          },
          files: ['consumer.ts'],
        }),
      );
      for (const name of ['typescript', 'typescript-next']) {
        await run(process.execPath, [resolve('node_modules', name, 'bin/tsc'), '-p', config]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('Describe accepts writes whose runtime constraints still fail', async () => {
  await fixture(async (namespace) => {
    const accounts = identifier(namespace, 'accounts');
    const messages = identifier(namespace, 'messages');
    for (const [query, code] of [
      [sql`INSERT INTO ${accounts} (id) VALUES (3) RETURNING id`, '23502'],
      [sql`UPDATE ${accounts} SET id = 1 WHERE id = 2 RETURNING id`, '23505'],
      [sql`UPDATE ${accounts} SET counter = -1 WHERE id = 1 RETURNING id`, '23514'],
      [sql`INSERT INTO ${messages} VALUES (4,999,1) RETURNING id`, '23503'],
    ] as const) {
      assert.equal((await describe(query)).columns[0]!.readType, 'number');
      await assert.rejects(execute(query), { code });
    }
    assert.deepEqual(
      [...(await pool.unsafe(`SELECT id FROM ${qualified(namespace, 'accounts')} ORDER BY id`))],
      [{ id: 1 }, { id: 2 }],
    );
  });
});

test('Describe does not execute writes, writable CTEs, volatile functions, or take query locks', async () => {
  await fixture(async (namespace) => {
    const accounts = identifier(namespace, 'accounts');
    const key = '7734681218761';
    const queries = [
      sql`INSERT INTO ${accounts} (id,name,quota,amount,payload,at,tags,amounts,state,counter)
        VALUES (3,'New',1,1,'{}','2026-01-01T00:00:00Z','{}','{}','ready',1) RETURNING id`,
      sql`UPDATE ${accounts} SET name='changed' RETURNING name`,
      sql`UPDATE ${accounts} SET name='changed'`,
      sql`DELETE FROM ${accounts} RETURNING id`,
      sql`WITH removed AS (DELETE FROM ${accounts} RETURNING id) SELECT * FROM removed`,
      sql`SELECT nextval(${qualified(namespace, 'probe_sequence')}::regclass) AS n`,
      sql`SELECT pg_advisory_lock(${key}::bigint) AS locked`,
      sql`SELECT * FROM ${accounts} FOR UPDATE`,
    ];
    for (const query of queries) {
      const description = await describe(query);
      if (!description.columns.length) assert.equal(description.rowType, null);
    }
    assert.deepEqual(
      [
        ...(await pool.unsafe(
          `SELECT id,name FROM ${qualified(namespace, 'accounts')} ORDER BY id`,
        )),
      ],
      [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Bea' },
      ],
    );
    assert.equal(
      (await pool.unsafe(`SELECT is_called FROM ${qualified(namespace, 'probe_sequence')}`))[0]!
        .is_called,
      false,
    );
    assert.equal(
      (
        await pool.unsafe(
          `SELECT count(*) FROM pg_catalog.pg_locks
      WHERE locktype='advisory' AND objid=($1::bigint & 4294967295)::oid`,
          [key],
        )
      )[0]!.count,
      '0',
    );
    const client = await pool.reserve();
    try {
      await client.unsafe('BEGIN');
      await client.unsafe(
        `LOCK TABLE ${qualified(namespace, 'accounts')} IN ACCESS EXCLUSIVE MODE NOWAIT`,
      );
    } finally {
      await client.unsafe('ROLLBACK');
      client.release();
    }
  });
});

test('successful Describe is not evidence that parameter values, JSON shapes or execution will work', async () => {
  for (const [query, code] of [
    [sql`SELECT ${'not-an-integer'}::integer AS value`, '22P02'],
    [sql`SELECT 1 / ${0} AS value`, '22012'],
  ] as const) {
    assert.equal((await describe(query)).columns[0]!.readType, 'number');
    await assert.rejects(execute(query), { code });
  }
  const query = sql<{ payload: { name: string } }>`SELECT '{"name":42}'::jsonb AS payload`;
  assert.equal((await describe(query)).columns[0]!.readType, 'unknown');
  const rows = await execute(query);
  assert.deepEqual(rows, [{ payload: { name: 42 } }]);
  assert.throws(() => {
    const payload = rows[0]!.payload as { name: unknown };
    assert.equal(typeof payload.name, 'string');
  }, assert.AssertionError);
});

test('duplicates, unmapped types and empty result sets cannot become false verification successes', async () => {
  const duplicate = await describe(`SELECT 1 AS id, 'last'::text AS id`);
  assert.equal(duplicate.rowType, null);
  assert.equal(duplicate.columns.length, 2);
  assert.ok(duplicate.issues.some((issue) => issue.code === 'duplicate-column'));
  assert.deepEqual(await execute(raw(`SELECT 1 AS id, 'last'::text AS id`)), [{ id: 'last' }]);
  const unknown = await describe(`SELECT interval '1 day' AS period`);
  assert.equal(unknown.columns[0]!.readType, 'unknown');
  assert.ok(unknown.issues.some((issue) => issue.code === 'unmapped-type'));
  const repeats = await describe(`SELECT interval '1 day' AS period, interval '2 days' AS period`);
  assert.equal(repeats.issues.filter((issue) => issue.code === 'unmapped-type').length, 1);
  assert.equal(repeats.issues.filter((issue) => issue.code === 'duplicate-column').length, 1);
  const noRows = await describe('SELECT 1 AS id WHERE false');
  assert.equal(noRows.columns[0]!.readType, 'number');
  assert.equal(noRows.columns[0]!.nullability, 'unknown');
  await assert.rejects(describe(''), /nonempty SQL text/);
  await assert.rejects(describeQuery({ connection: '', query: 'SELECT 1' }), /connection string/);
});

test('public inspection input errors are explicit before a connection is opened', async () => {
  for (const query of [undefined, null, 7, {}, { text: 7 }]) {
    await assert.rejects(
      describeQuery({
        connection: 'postgresql://unused',
        // @ts-expect-error simulate untyped JavaScript callers
        query,
      }),
      /nonempty SQL/,
    );
  }
  await assert.rejects(
    describeQuery({
      connection: 'postgresql://unused',
      query: 'SELECT 1',
      // @ts-expect-error unknown public options are rejected at runtime too
      check: true,
    }),
    /Unknown Describe option/,
  );
  await assert.rejects(
    describeQuery({ connection: 'https://example.invalid', query: 'SELECT 1' }),
    /PostgreSQL connection URI/,
  );
  await assert.rejects(
    describeQuery({ connection: 'invalid', query: 'SELECT 1' }),
    /PostgreSQL connection URI/,
  );
});

test('CLI describes a parameterized SQL file and reports failures as a nonzero exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-describe-cli-'));
  const file = join(directory, 'query.sql');
  const cli = resolve('.test-dist/src/cli.js');
  const env = { ...process.env, DATABASE_URL: testConnection };
  try {
    await writeFile(file, 'SELECT $1::integer AS id, count(*) AS total FROM pg_catalog.pg_class');
    const result = await run(
      process.execPath,
      [
        cli,
        'describe',
        file,
        '--search-path',
        'pg_catalog',
        '--time-zone',
        'UTC',
        '--statement-timeout-ms',
        '800',
        '--lock-timeout-ms',
        '100',
      ],
      { env },
    );
    const output = JSON.parse(result.stdout) as {
      columns: { name: string; readType: string }[];
      parameters: unknown[];
      context: {
        searchPath: string;
        timeZone: string;
        statementTimeoutMs: number;
        lockTimeoutMs: number;
      };
    };
    assert.deepEqual(
      output.columns.map((c) => [c.name, c.readType]),
      [
        ['id', 'number'],
        ['total', 'string'],
      ],
    );
    assert.equal(output.parameters.length, 1);
    assert.equal(output.context.searchPath, 'pg_catalog');
    assert.equal(output.context.timeZone, 'UTC');
    assert.equal(output.context.statementTimeoutMs, 800);
    assert.equal(output.context.lockTimeoutMs, 100);
    for (const flags of [['--namespace', 'public'], ['--directory', directory], ['--check']]) {
      await assert.rejects(run(process.execPath, [cli, 'describe', file, ...flags], { env }), {
        code: 1,
      });
    }
    await assert.rejects(run(process.execPath, [cli, 'describe'], { env }), { code: 1 });
    await assert.rejects(run(process.execPath, [cli, 'describe', file, file], { env }), {
      code: 1,
    });
    await assert.rejects(
      run(process.execPath, [cli, 'describe', file, '--connect-timeout-ms', '0'], { env }),
      {
        code: 1,
      },
    );
    await writeFile(file, 'SELECT no_such_column FROM pg_catalog.pg_class');
    await assert.rejects(run(process.execPath, [cli, 'describe', file], { env }), { code: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
