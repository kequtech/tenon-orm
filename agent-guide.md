# Using Tenon

Tenon provides SQL execution, SQL migrations, and generated TypeScript row types.
It uses `pg` without transforming its values. There are no model classes,
automatic relation loaders, or schema synchronization.

When working in an existing project, read its database connection setup, generated
schema, relevant operations, migrations, and test commands first. Reuse its pool,
SQL conventions, and environment setup. Keep application validation and business
rules in the application. See [adoption](adoption-guide.md) when replacing another ORM.

## Install and connect

Use Node.js 24+, PostgreSQL 16+, and ESM:

```sh
npm install @kequtech/tenon-orm pg
npm install --save-dev typescript@^6 @types/node@^24 @types/pg
```

TypeScript projects need `"type": "module"` in package.json and
`"module": "NodeNext"`, `"strict": true` in tsconfig.json.

```ts
import { createTenon } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
export const db = createTenon({ connection });
```

`connection` accepts a connection string, `pg.PoolConfig`, or existing `pg.Pool`.
Use `{}` explicitly for pg's environment defaults. `db.close()` closes pools Tenon
creates and leaves supplied pools open; finish outstanding work before closing.
A server should reuse its database instance and close it at shutdown.
With a supplied pool, install the application's `pool.on('error', handler)`;
Tenon reports idle errors on owned pools through `process.emitWarning`.

Qualify SQL table names or configure the connection's `search_path`.
The CLI's `--namespace` only selects the schema used by tooling.

## Create or change the schema

```sh
npx tenon new create_users
```

Fill the generated files:

```sql
-- migrations/0001_create_users.up.sql
CREATE TABLE "User" (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);
```

```sql
-- migrations/0001_create_users.down.sql
DROP TABLE "User";
```

Set `DATABASE_URL` through the application's environment setup, then run:

```sh
npx tenon migrate
npx tenon generate --out src/generated-schema.ts
```

Commit migrations and generated definitions. For later changes, add a new
migration, apply it to the development/test database, regenerate, and run the
application's SQL checks and database tests. Applied migration files are immutable.
If a migration is intentionally irreversible, omit its down file; do not leave
an empty scaffold file. A down migration is not a backup.

## Queries and reusable operations

```ts
import { defineOperation, sql } from '@kequtech/tenon-orm';
import type { User } from './generated-schema.js';
import { db } from './db.js';

type UserSummary = Pick<User, 'id' | 'email'>;

export const userByEmail = defineOperation(
  (email: string) => sql<UserSummary>`
    SELECT id, email FROM public."User" WHERE email = ${email}
  `,
  { returns: 'oneOrNone' },
);

const user = await db.run(userByEmail, ['agent@example.test']);
const users = await db.query(sql<UserSummary>`SELECT id, email FROM public."User" ORDER BY id`, {
  returns: 'many',
});
```

Export operations from ordinary modules and import them where needed. A factory
runs when called and must synchronously return a query. Inputs come from its
function parameters; result types come from `sql<Row>`. For several related
inputs, use one typed object: `(input: { email: string; active: boolean }) => ...`
and `db.run(operation, [{ email, active }])`. `run` always takes an input array,
including `[]` for a parameterless factory. Options belong to the definition.

| `returns`          | Result                | Returned rows allowed |
| ------------------ | --------------------- | --------------------- |
| `native` (default) | pg `QueryResult<Row>` | Any                   |
| `many`             | `Row[]`               | Any, including zero   |
| `oneOrNone`        | `Row \| undefined`    | Zero or one           |
| `one`              | `Row`                 | Exactly one           |

`query` and `defineOperation` accept `{ returns?, affectedRows?, label? }`.
`label` is an optional diagnostic name. Native results retain `command`,
`rowCount`, `fields`, and `rows`; a null row count means none was reported.
`returns` does not add `RETURNING` or `LIMIT` to SQL. Use `oneOrNone` when absence
is an expected result.

The row generic describes one record. Without it, fields are `unknown` and need
narrowing. Declaring a row type does not prove the SQL matches it or validate
returned JSON; use SQL checking and application validation where appropriate.

## SQL parameters and common patterns

The `sql` tag binds interpolations as `$1`, `$2`, etc. Do not quote interpolations
or mix manual `$n` placeholders into a tagged query. Values use pg's conversions,
including arrays, JSON, dates, and `undefined` becoming SQL null.

```ts
const ids = [1, 2, 3];
const selected = await db.query(
  sql<UserSummary>`SELECT id, email FROM public."User" WHERE id = ANY(${ids}::integer[])`,
  { returns: 'many' },
);

const active: boolean | null = null; // null means no filter
const filtered = await db.query(
  sql<UserSummary>`SELECT id, email FROM public."User"
    WHERE (${active}::boolean IS NULL OR active = ${active}) ORDER BY id`,
  { returns: 'many' },
);
```

Joins, CTEs, upserts (`ON CONFLICT`), batch inserts (`unnest`), views, and pagination
use normal SQL. Give projections their actual result shape; outer joins can add
nulls. For fixed alternatives such as sort direction, choose between complete
queries in the factory.

`identifier(schema, table)` explicitly quotes identifier components. Use names
chosen or allowed by the application; quoting does not authorize access:

```ts
import { identifier, unsafeSql } from '@kequtech/tenon-orm';

await db.query(sql`SELECT count(*) FROM ${identifier('public', 'User')}`);
```

Nested query tokens and raw fragments are unsupported. For SQL loaded from a file
or another trusted source, use `unsafeSql<Row>(text, values)`, with an explicit
array even when empty. Never concatenate application input into SQL text.
Each public query executes one statement, including parameterless queries.

## Transactions and guarded writes

```ts
await db.transaction(async (tx) => {
  const id = 42;
  await tx.query(sql`UPDATE public."User" SET active = false WHERE id = ${id}`, {
    affectedRows: { exact: 1 },
  });
  // Use tx for every query that belongs to this transaction.
});
```

The callback commits on success and rolls back when an error escapes. Await all
work before returning; the callback client expires afterward. A helper accepting
`QueryClient` works with either `db` or `tx`. Nested callback transactions and
automatic retries are not provided.

`affectedRows: { exact: n }` requires n affected rows; `{ max: n }` permits up to n.
Both require nonnegative safe integers. Checks apply to INSERT, UPDATE, DELETE,
and MERGE, independent of `RETURNING`. A root call uses a transaction; a call on
`tx` uses a savepoint. A mismatch rolls back before throwing. You may catch a
guarded failure and continue the outer transaction. Unguarded PostgreSQL errors
normally abort that transaction, even when caught.

The count covers the final command, excluding additional trigger, cascade, or CTE
effects. It cannot identify the wrong single row. Returned-row checks alone do
not undo autocommitted writes. Rollback cannot undo sequence advances or external
side effects of database functions.

Set isolation and timeouts with SQL, for example `SET TRANSACTION ISOLATION LEVEL
SERIALIZABLE` before data queries and `SET LOCAL statement_timeout = '5s'`.
Manual savepoints are available through SQL; reserve `tenon_affected_rows_` names
for Tenon. Direct BEGIN/COMMIT/ROLLBACK boundaries are owned by `transaction`.

SQL errors retain pg's codes and details. Invalid inputs and returned-row
mismatches throw ordinary `Error` objects. `AffectedRowsError` carries `expected`,
`actual`, `command`, and code `TENON_AFFECTED_ROWS_MISMATCH` or
`TENON_AFFECTED_ROWS_UNSUPPORTED`. When both work and cleanup fail, `AggregateError`
preserves both failures. A lost commit acknowledgment can leave the outcome unknown;
retry only when the application's operation makes that safe.

Optional `createTenon({ connection, onQuery })` observes completed calls with
`label`, `durationMs`, `outcome`, and available `command`, `rowCount`, `errorCode`.
It receives no SQL or values. Observers are not awaited; failures emit warnings.
A successful callback query does not mean its outer transaction has committed.

## Generated types and checking

`generateDefinitions({ connection, namespace?, onWarning? })` returns TypeScript
source for the connected schema. It does not need migration files or history.
The CLI writes that source atomically. This command checks the existing file
without rewriting it:

```sh
npx tenon generate --out src/generated-schema.ts --check
```

`--check` compares the generated representation with the current database. Pending
migration files are a separate concern. The representation includes table columns,
constraints, indexes, and referenced domains, not every PostgreSQL object.

Generation reads a consistent snapshot of ordinary tables and partitioned roots.
Use `Rows["exact SQL table name"]` or a named alias when the name is a legal
TypeScript alias. Views, foreign tables, and attached partitions use query-specific
types. A missing namespace fails; an existing empty schema is valid.

| PostgreSQL type                                | Default pg value                                |
| ---------------------------------------------- | ----------------------------------------------- |
| smallint, integer, oid, real, double precision | `number`                                        |
| bigint, numeric                                | `string`                                        |
| boolean                                        | `boolean`                                       |
| text, varchar, char, uuid, time, timetz        | `string`                                        |
| date, timestamp, timestamptz                   | `Date \| number` (numbers represent infinities) |
| enum                                           | String literal union; `never` for an empty enum |
| json, jsonb                                    | `unknown`                                       |
| bytea                                          | `Buffer`                                        |

Nullable columns add null. Domains use verified underlying mappings and the
column's own nullability. Unverified types warn and become `unknown`.
Verified arrays use `PgArray<T> = (T | null | PgArray<T>)[]` for null elements and
multiple dimensions. Numeric arrays contain numbers and can lose precision;
cast to text[] for exact values. Enum arrays and arrays of domains are unverified.
Finite dates and timestamps without time zone use Node's local timezone.
Custom pg parsers need matching application types.

## Optional SQL checking with SafeQL

SafeQL checks SQL and declared projections against a database during linting.
It is development tooling; Tenon does not load it at runtime. The tested setup
uses TypeScript 6, SafeQL 5.4, ESLint 10, and typescript-eslint 8:

```sh
npm install --save-dev typescript@~6.0.2 eslint typescript-eslint @ts-safeql/eslint-plugin
```

Merge this configuration into the application's `eslint.config.mjs`:

```js
import safeql from '@ts-safeql/eslint-plugin/config';
import tseslint from 'typescript-eslint';

export default [
  tseslint.configs.base,
  { files: ['src/**/*.ts'], languageOptions: { parserOptions: { project: './tsconfig.json' } } },
  {
    ...safeql.configs.connections({
      databaseUrl: process.env.DATABASE_URL,
      targets: [{ tag: 'sql' }],
      inferLiterals: false,
      overrides: {
        types: {
          int8: 'string',
          numeric: 'string',
          json: 'unknown',
          jsonb: 'unknown',
          date: 'Date | number',
          timestamp: 'Date | number',
          timestamptz: 'Date | number',
        },
      },
    }),
    files: ['src/**/*.ts'],
  },
];
```

Run `npx eslint "src/**/*.ts"` against the intended development/test schema.
Factories work with the same `sql` target; aliases need a matching target name.
For a generated array, add a column override such as
`columns: { 'User.tags': 'PgArray<string>' }` and import `PgArray` in the query file.
Keys use `Table.column`, so duplicate table names across schemas need care.
Custom parsers require corresponding overrides. SafeQL does not inspect
`unsafeSql` or generally resolve runtime identifiers. Database tests still need
to verify application behavior.

## Command reference

All database commands use `DATABASE_URL`; environment files are not loaded automatically.

```text
tenon new <name> [--directory migrations]
tenon migrate [--directory migrations] [--namespace public]
tenon status [--directory migrations] [--namespace public]
tenon rollback [--directory migrations] [--namespace public] [--steps 1]
tenon generate [--namespace public] [--out src/generated-schema.ts] [--check]
tenon baseline capture|adopt [--directory migrations] [--namespace public]
```

Migration filenames are `<numeric-id>_<name>.up.sql` and optional matching down
files. IDs sort numerically. Each migration and its history entry commit together;
earlier files remain applied if a later file fails. Status reports applied/pending
IDs. Rollback checks that every selected file has down SQL before executing any.
Use dollar-quoted function bodies and explicit `E'...'` for backslash escapes.
Nontransactional DDL such as `CREATE INDEX CONCURRENTLY` needs a separate procedure.

Tools coordinate through session advisory locks per database/namespace. Use direct
connections or session pooling, with PostgreSQL timeouts to bound waiting.

Programmatic `migrate`, `migrationStatus`, and `rollback` accept
`{ connection, directory?, namespace? }`; rollback also accepts `steps`.
`createMigration({ name, directory? })` scaffolds files;
`readMigrations(directory?)` reads validated SQL and checksums.
Baseline capture/adoption are covered in the [adoption guide](adoption-guide.md).
