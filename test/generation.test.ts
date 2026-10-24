import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import {
  createTenon,
  generateDefinitions,
  identifier,
  migrate,
  migrationStatus,
  rollback,
  sql,
} from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import { recordMigrations } from './fixtures/record-migrations.js';
import {
  assertTestDatabase,
  testConnection as connection,
  migrationProject,
} from './helpers/database.js';
import { checkGeneratedTypes, typeAssertions } from './helpers/generation.js';
const pool = new Pool({ connectionString: connection });
const project = migrationProject(pool);
before(() => assertTestDatabase(pool));
after(() => pool.end());
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('fresh migration replay generates the exact committed definitions independently of namespace', async () => {
  await project({}, async (options) => {
    await cp(resolve('test/fixtures/migrations'), options.directory, { recursive: true });
    assert.deepEqual(await migrate(options), ['0001']);
    assert.deepEqual(await migrate(options), []);
    assert.deepEqual(await migrationStatus(options), { applied: ['0001'], pending: [] });
    const source = await generateDefinitions(options);
    assert.equal(source, await readFile(resolve('test/fixtures/generated-schema.ts'), 'utf8'));
    assert.equal(await generateDefinitions(options), source);
  });
});

test('ordinary generated row types compose with Pick and indexed access across migration checkpoints', async () => {
  await project(
    {
      ...recordMigrations,
      '0002_enabled.up.sql':
        'ALTER TABLE "Record" ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT true;',
      '0002_enabled.down.sql': 'ALTER TABLE "Record" DROP COLUMN enabled;',
    },
    async (options) => {
      await migrate(options);
      await checkGeneratedTypes(
        options,
        `
      import type { Record as DatabaseRecord, Rows } from './definitions.js';
      ${typeAssertions}
      type Complete = Assert<Equal<DatabaseRecord, { id: number; name: string; enabled: boolean }>>;
      type Projection = Assert<Equal<Pick<DatabaseRecord, 'id' | 'name'>, { id: number; name: string }>>;
      type Input = Assert<Equal<[name: DatabaseRecord['name']], [name: string]>>;
      type Mapped = Assert<Equal<Rows['Record'], DatabaseRecord>>;
      // @ts-expect-error defaulted columns are required in full returned rows
      const incomplete: DatabaseRecord = { id: 1, name: 'test' };
      // @ts-expect-error generated column names constrain Pick
      type InvalidProjection = Pick<DatabaseRecord, 'missing'>;
    `,
      );
      await rollback(options);
      await checkGeneratedTypes(
        options,
        `
      import type { Record as DatabaseRecord } from './definitions.js';
      ${typeAssertions}
      type Current = Assert<Equal<DatabaseRecord, { id: number; name: string }>>;
      // @ts-expect-error the rolled-back column is absent from this schema checkpoint
      type Removed = DatabaseRecord['enabled'];
    `,
      );
      await migrate(options);
      await checkGeneratedTypes(
        options,
        `
      import type { Record as DatabaseRecord } from './definitions.js';
      ${typeAssertions}
      type Restored = Assert<Equal<DatabaseRecord['enabled'], boolean>>;
    `,
      );
    },
  );
});

test('generation reads an existing schema without migration files or history', async () => {
  await project({}, async (options) => {
    await pool.query(`CREATE SCHEMA ${quote(options.namespace)};
      CREATE TABLE ${qualified(options.namespace, 'Account')} (id integer PRIMARY KEY);`);
    const source = await generateDefinitions({ connection: pool, namespace: options.namespace });
    await checkGeneratedTypes(
      options,
      `
      import type { Account } from './definitions.js';
      ${typeAssertions}
      type Row = Assert<Equal<Account, { id: number }>>;
    `,
    );
    // Even an unfinished migration is unrelated to the connected schema.
    await writeFile(join(options.directory, '0001_draft.up.sql'), '');
    assert.equal(await generateDefinitions(options), source);
    await pool.query(`ALTER TABLE ${qualified(options.namespace, 'Account')} ADD COLUMN name text`);
    assert.notEqual(await generateDefinitions(options), source);
  });
});

test('empty enums generate usable types for nullable and required columns', async () => {
  await project(
    {
      '0001_enum.up.sql': `CREATE TYPE empty_enum AS ENUM ();
      CREATE TABLE "Empty" (optional empty_enum, required empty_enum NOT NULL);`,
    },
    async (options) => {
      await migrate(options);
      await checkGeneratedTypes(
        options,
        `
      import type { Empty } from './definitions.js';
      ${typeAssertions}
      type Optional = Assert<Equal<Empty['optional'], null>>;
      type Required = Assert<Equal<Empty['required'], never>>;
    `,
      );
    },
  );
});

test('generated types preserve unusual SQL names, module-name collisions and date types', async () => {
  const names = [
    'user-details',
    'class',
    'as',
    'Rows',
    'Inserts',
    'Updates',
    'tables',
    'column',
    'index',
    'createTable',
    'migrationHistory',
    'Date',
    'globalThis',
    'string',
    '__proto__',
    '東京',
    '1st',
    'type',
    'readonly',
  ];
  const sql = names
    .map(
      (name) =>
        `CREATE TABLE ${quote(name)} (id INTEGER PRIMARY KEY, "created at" TIMESTAMPTZ NOT NULL, "nullable-value" TEXT, "__proto__" TEXT NOT NULL);`,
    )
    .join('\n');
  await project({ '0001_unusual.up.sql': sql }, async (options) => {
    await migrate(options);
    await checkGeneratedTypes(
      options,
      `
      import type { Rows, Inserts, Updates, Date as DateRow, 東京 } from './definitions.js';
      ${typeAssertions}
      type Expected = { id: number; 'created at': globalThis.Date | number; 'nullable-value': string | null; '__proto__': string };
      type Matches = { [Name in keyof Rows]: Equal<Rows[Name], Expected> };
      type AllRows = Assert<Equal<Matches[keyof Rows], true>>;
      type NamedInserts = Assert<Equal<Inserts, Rows['Inserts']>>;
      type NamedUpdates = Assert<Equal<Updates, Rows['Updates']>>;
      type ReservedInsert = Assert<Equal<Rows.Insert['Inserts']['id'], number>>;
      type ReservedUpdate = Assert<Equal<Rows.Update['Updates']['id'], number | undefined>>;
      type UnicodeAlias = Assert<Equal<東京, Expected>>;
      type DateAlias = Assert<Equal<DateRow['created at'], globalThis.Date | number>>;
      type ExactName = Assert<Equal<Pick<Rows['user-details'], 'nullable-value'>, { 'nullable-value': string | null }>>;
      // @ts-expect-error SQL column names are preserved rather than converted
      type Renamed = Rows['user-details']['createdAt'];
      // @ts-expect-error SQL table names are preserved rather than converted
      type RenamedTable = Rows['UserDetails'];
    `,
    );
    await checkGeneratedTypes(
      options,
      `
      import type { Rows } from './definitions.js';
      ${typeAssertions}
      type Names = Assert<Equal<keyof Rows, ${names.map((name) => JSON.stringify(name)).join(' | ')}>>;
    `,
    );
  });
});

test('row generation needs no unique key and accepts indexes and generated expression columns', async () => {
  await project(
    {
      ...recordMigrations,
      '0002_sql_features.up.sql': `
    CREATE TABLE "NoKey" (value TEXT);
    CREATE UNIQUE INDEX partial_name ON "Record" (name) WHERE name <> '';
    CREATE INDEX expression_name ON "Record" (lower(name));
    ALTER TABLE "Record" ADD COLUMN upper_name TEXT GENERATED ALWAYS AS (upper(name)) STORED;
  `,
    },
    async (options) => {
      await migrate(options);
      await checkGeneratedTypes(
        options,
        `
      import type { Record as DatabaseRecord, NoKey } from './definitions.js';
      ${typeAssertions}
      type RecordRow = Assert<Equal<DatabaseRecord, { id: number; name: string; upper_name: string | null }>>;
      type KeylessRow = Assert<Equal<NoKey, { value: string | null }>>;
    `,
      );
    },
  );
});

test('generation includes ordinary tables and partitioned roots while skipping attached descendants', async () => {
  await project(
    {
      '0001_partitions.up.sql': `
    CREATE TABLE "Events" (
      id INTEGER NOT NULL, tenant INTEGER NOT NULL, label TEXT,
      tags INTEGER[] NOT NULL DEFAULT '{}', payload JSONB, lag INTERVAL
    ) PARTITION BY RANGE (id);
    CREATE TABLE "EventsRecent" PARTITION OF "Events"
      FOR VALUES FROM (1) TO (100) PARTITION BY LIST (tenant);
    CREATE TABLE "EventsRecentA" PARTITION OF "EventsRecent" FOR VALUES IN (1);
    CREATE TABLE "EventsRecentOther" PARTITION OF "EventsRecent" DEFAULT;
    CREATE TABLE "EventsArchive" PARTITION OF "Events" FOR VALUES FROM (100) TO (200);
    CREATE TABLE "EventsFallback" PARTITION OF "Events" DEFAULT;
    ALTER TABLE "EventsRecentA" ALTER COLUMN label SET NOT NULL;
    ALTER TABLE "EventsRecentA" ALTER COLUMN label SET DEFAULT 'local default';
    CREATE TABLE "EmptyEvents" (id INTEGER NOT NULL) PARTITION BY RANGE (id);
    CREATE TABLE "Standalone" (id INTEGER NOT NULL, label TEXT);
    ALTER TABLE "Events" ADD COLUMN obsolete TEXT;
    ALTER TABLE "Events" DROP COLUMN obsolete;
  `,
    },
    async (options) => {
      await migrate(options);
      const warnings: string[] = [];
      const source = await generateDefinitions({
        ...options,
        onWarning: (message) => warnings.push(message),
      });
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0]!.includes('"Events"."lag"'));
      assert.equal(await generateDefinitions({ ...options, onWarning: () => {} }), source);
      await checkGeneratedTypes(
        { ...options, onWarning: () => {} },
        `
      import type { Rows, Events, EmptyEvents, Standalone, PgArray } from './definitions.js';
      ${typeAssertions}
      type Expected = { id: number; tenant: number; label: string | null;
        tags: PgArray<number>; payload: unknown; lag: unknown };
      type AllNames = Assert<Equal<keyof Rows, 'Events' | 'EmptyEvents' | 'Standalone'>>;
      type Parent = Assert<Equal<Events, Expected>>;
      type EmptyParent = Assert<Equal<EmptyEvents, { id: number }>>;
      type Ordinary = Assert<Equal<Standalone, { id: number; label: string | null }>>;
      // @ts-expect-error intermediate attached parents are not generated
      type Intermediate = Rows['EventsRecent'];
      // @ts-expect-error local leaves do not get separate named exports
      import type { EventsRecentA } from './definitions.js';
      // @ts-expect-error nullable parent fields still require narrowing
      ({} as Events).label.toUpperCase();
      // @ts-expect-error dropped inherited columns are absent
      type Dropped = Events['obsolete'];
    `,
      );
      // Routine partition maintenance changes neither row types nor schema summaries.
      await pool.query(`CREATE TABLE ${qualified(options.namespace, 'EventsTomorrow')}
      PARTITION OF ${qualified(options.namespace, 'Events')} FOR VALUES FROM (200) TO (300)`);
      assert.equal(await generateDefinitions({ ...options, onWarning: () => {} }), source);
      await pool.query(`DROP TABLE ${qualified(options.namespace, 'EventsTomorrow')}`);
      assert.equal(await generateDefinitions({ ...options, onWarning: () => {} }), source);
      const db = createTenon({ connection: pool });
      try {
        await db.query(sql`INSERT INTO ${identifier(options.namespace, 'Events')} (id, tenant, label)
        VALUES (1, 1, 'first'), (2, 2, NULL), (101, 1, NULL), (250, 1, NULL)`);
        await db.query(
          sql`INSERT INTO ${identifier(options.namespace, 'EventsRecentA')} (id, tenant) VALUES (3, 1)`,
        );
        const all = await db.query(
          sql<{
            id: number;
            label: string | null;
          }>`SELECT id, label FROM ${identifier(options.namespace, 'Events')} ORDER BY id`,
          { returns: 'many' },
        );
        assert.deepEqual(all, [
          { id: 1, label: 'first' },
          { id: 2, label: null },
          { id: 3, label: 'local default' },
          { id: 101, label: null },
          { id: 250, label: null },
        ]);
        const leaf = await db.query(
          sql<{
            id: number;
            label: string | null;
          }>`SELECT id, label FROM ${identifier(options.namespace, 'EventsRecentA')} ORDER BY id`,
          { returns: 'many' },
        );
        assert.deepEqual(leaf, [
          { id: 1, label: 'first' },
          { id: 3, label: 'local default' },
        ]);
        await assert.rejects(
          db.query(
            sql`INSERT INTO ${identifier(options.namespace, 'Events')} (id, tenant, label) VALUES (4, 1, NULL)`,
          ),
          { code: '23502' },
        );
        // Detachment makes the table an independent model with its own constraints.
        await pool.query(`ALTER TABLE ${qualified(options.namespace, 'EventsRecent')}
        DETACH PARTITION ${qualified(options.namespace, 'EventsRecentA')}`);
        await checkGeneratedTypes(
          { ...options, onWarning: () => {} },
          `
        import type { Rows, EventsRecentA } from './definitions.js';
        ${typeAssertions}
        type Detached = Assert<Equal<keyof Rows, 'Events' | 'EmptyEvents' | 'Standalone' | 'EventsRecentA'>>;
        type IndependentNullability = Assert<Equal<EventsRecentA['label'], string>>;
      `,
        );
        await pool.query(`ALTER TABLE ${qualified(options.namespace, 'EventsRecent')}
        ATTACH PARTITION ${qualified(options.namespace, 'EventsRecentA')} FOR VALUES IN (1)`);
        assert.equal(await generateDefinitions({ ...options, onWarning: () => {} }), source);
        await writeFile(
          join(options.directory, '0002_column.up.sql'),
          'ALTER TABLE "Events" ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT true;',
        );
        await migrate(options);
        await checkGeneratedTypes(
          { ...options, onWarning: () => {} },
          `
        import type { Rows } from './definitions.js';
        ${typeAssertions}
        type UpdatedParent = Assert<Equal<Rows['Events']['enabled'], boolean>>;
        // @ts-expect-error unrelated parents do not acquire another hierarchy's column
        type Unchanged = Rows['EmptyEvents']['enabled'];
      `,
        );
        const updated = await db.query(
          sql<{
            enabled: boolean;
          }>`SELECT enabled FROM ${identifier(options.namespace, 'EventsRecentA')} ORDER BY id`,
          { returns: 'many' },
        );
        assert.deepEqual(updated, [{ enabled: true }, { enabled: true }]);
      } finally {
        await db.close();
      }
    },
  );
});

test('foreign tables use authored types without affecting ordinary table generation or freshness', async () => {
  const wrapper = `tenon_fdw_${randomUUID().replaceAll('-', '')}`;
  const server = `tenon_server_${randomUUID().replaceAll('-', '')}`;
  try {
    // Declaration-only wrapper: no extension, handler or external connection.
    await pool.query(`CREATE FOREIGN DATA WRAPPER ${quote(wrapper)} NO HANDLER NO VALIDATOR`);
    await pool.query(`CREATE SERVER ${quote(server)} FOREIGN DATA WRAPPER ${quote(wrapper)}`);
    await project(
      {
        '0001_tables.up.sql': `
      CREATE TABLE "Local" (id integer NOT NULL, name text);
      CREATE TABLE "Root" (id integer) PARTITION BY RANGE (id);
      CREATE DOMAIN "ForeignOnly" AS interval;
    `,
      },
      async (options) => {
        await migrate(options);
        const source = await generateDefinitions(options);
        const output = join(options.directory, 'definitions.ts');
        await writeFile(output, source);
        await pool.query(`CREATE FOREIGN TABLE ${qualified(options.namespace, 'ForeignRecord')}
        (id integer, duration ${qualified(options.namespace, 'ForeignOnly')}, tags integer[])
        SERVER ${quote(server)}`);
        await pool.query(`CREATE FOREIGN TABLE ${qualified(options.namespace, 'ForeignDaily')}
        PARTITION OF ${qualified(options.namespace, 'Root')} DEFAULT SERVER ${quote(server)}`);
        const warnings: string[] = [];
        assert.equal(
          await generateDefinitions({ ...options, onWarning: (message) => warnings.push(message) }),
          source,
        );
        assert.deepEqual(warnings, []);
        await run(
          process.execPath,
          [cli, 'generate', '--namespace', options.namespace, '--out', output, '--check'],
          { env: { ...process.env, DATABASE_URL: connection } },
        );
        assert.equal(await readFile(output, 'utf8'), source);
        await checkGeneratedTypes(
          options,
          `
        import type { Rows, Local, Root } from './definitions.js';
        ${typeAssertions}
        type Names = Assert<Equal<keyof Rows, 'Local' | 'Root'>>;
        type LocalRow = Assert<Equal<Local, { id: number; name: string | null }>>;
        type RootRow = Assert<Equal<Root, { id: number | null }>>;
        // @ts-expect-error foreign tables have manually authored query contracts
        type ForeignRow = Rows['ForeignRecord'];
        // @ts-expect-error attached foreign partitions do not have generated aliases
        import type { ForeignDaily } from './definitions.js';
        // @ts-expect-error skipped foreign array columns do not introduce helpers
        import type { PgArray } from './definitions.js';
      `,
        );
        await pool.query(`DROP TABLE ${qualified(options.namespace, 'Local')}`);
        await pool.query(`DROP TABLE ${qualified(options.namespace, 'Root')}`);
        const onlyForeign = await generateDefinitions(options);
        assert.equal(onlyForeign, await generateDefinitions(options));
        await checkGeneratedTypes(
          options,
          `
        import type { Rows } from './definitions.js';
        ${typeAssertions}
        type NoGeneratedTables = Assert<Equal<keyof Rows, never>>;
      `,
        );
      },
    );
  } finally {
    try {
      await pool.query(`DROP SERVER IF EXISTS ${quote(server)} CASCADE`);
    } finally {
      await pool.query(`DROP FOREIGN DATA WRAPPER IF EXISTS ${quote(wrapper)}`);
    }
  }
});

test('views always use authored types and do not block table generation', async () => {
  await project(
    {
      ...recordMigrations,
      '0002_views.up.sql': `
    INSERT INTO "Record" (name) VALUES ('example');
    CREATE VIEW "RecordView" AS SELECT id, name, INTERVAL '1 day' AS age FROM "Record";
    CREATE MATERIALIZED VIEW "RecordSnapshot" AS SELECT id, name FROM "Record";
  `,
    },
    async (options) => {
      await migrate(options);
      await checkGeneratedTypes(
        options,
        `
      import type { Record as DatabaseRecord, Rows } from './definitions.js';
      ${typeAssertions}
      type TablesOnly = Assert<Equal<keyof Rows, 'Record'>>;
      type PhysicalRow = Assert<Equal<DatabaseRecord, { id: number; name: string }>>;
      type AuthoredView = Pick<DatabaseRecord, 'id' | 'name'> & { age: string };
      // @ts-expect-error view types are always authored alongside their SQL
      type View = Rows['RecordView'];
      // @ts-expect-error materialized views follow the same manual type policy
      type Snapshot = Rows['RecordSnapshot'];
    `,
      );
      const db = createTenon({ connection: pool });
      try {
        type AuthoredView = { id: number; name: string; age: string };
        const view = await db.query(
          sql<AuthoredView>`SELECT id, name, age::text AS age FROM ${identifier(options.namespace, 'RecordView')}`,
        );
        assert.deepEqual(view.rows, [{ id: 1, name: 'example', age: '1 day' }]);
        const snapshot = await db.query(
          sql<{
            id: number;
            name: string;
          }>`SELECT id, name FROM ${identifier(options.namespace, 'RecordSnapshot')}`,
        );
        assert.deepEqual(snapshot.rows, [{ id: 1, name: 'example' }]);
      } finally {
        await db.close();
      }
    },
  );
});

test('a schema containing only views generates an empty table type map', async () => {
  await project(
    {
      '0001_views.up.sql': `
    CREATE VIEW "ManualView" AS SELECT INTERVAL '1 day' AS age;
    CREATE MATERIALIZED VIEW "ManualSnapshot" AS SELECT 1 AS value;
  `,
    },
    async (options) => {
      await migrate(options);
      await checkGeneratedTypes(
        options,
        `
      import type { Rows } from './definitions.js';
      ${typeAssertions}
      type NoTables = Assert<Equal<keyof Rows, never>>;
      type NoInserts = Assert<Equal<Rows.Insert[keyof Rows], never>>;
      type NoUpdates = Assert<Equal<Rows.Update[keyof Rows], never>>;
      // @ts-expect-error views do not have generated mutation input types
      type ViewInput = Rows.Insert['ManualView'];
    `,
      );
      assert.deepEqual(await migrationStatus(options), { applied: ['0001'], pending: [] });
    },
  );
});
