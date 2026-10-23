# Using Tenon: a human guide

Tenon provides SQL execution, SQL migrations, and generated TypeScript row types.
It uses `pg` without transforming its values. There are no model classes,
automatic relation loaders, or schema synchronization.

You write PostgreSQL queries directly. Tenon binds input values, executes queries,
controls transactions, and gives you explicit choices about returned rows. Your
application supplies the database connection and owns validation and business rules.

There are three separate kinds of checking:

- **Generated row types** describe full table rows at a database checkpoint.
- **Query annotations** describe the actual selected columns, joins, or expressions.
  SafeQL can generate and check those annotations during development.
- **Runtime checks** enforce returned-row counts and optional affected-row limits.
  Type annotations do not validate arbitrary JSON or replace application validation.

Start with this guide. The [agent guide](agent-guide.md) is a compact implementation
reference; [adoption](adoption-guide.md) covers replacing an existing ORM.

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

An ordinary function is enough for most application queries:

```ts
import { sql } from '@kequtech/tenon-orm';
import type { User } from './generated-schema.js';
import { db } from './db.js';

type UserSummary = Pick<User, 'id' | 'email'>;

export async function userByEmail(email: string) {
  return db.query(sql<UserSummary>`SELECT id, email FROM public."User" WHERE email = ${email}`, {
    returns: 'oneOrNone',
  });
}

const user = await userByEmail('reader@example.test');
```

The `sql` tag binds the email as a parameter. The row annotation describes one row;
`returns: 'oneOrNone'` makes the result `UserSummary | undefined` and rejects more
than one row. You can also omit the handwritten annotation and let the
[SafeQL workflow](#result-typing-with-safeql) generate it.

Use `defineOperation` when a reusable query definition should carry its execution
options and be run on either a database or transaction:

```ts
import { defineOperation, sql } from '@kequtech/tenon-orm';

export const userByEmailQuery = defineOperation(
  (email: string) => sql<UserSummary>`
    SELECT id, email FROM public."User" WHERE email = ${email}
  `,
  { returns: 'oneOrNone' },
);

const user = await db.run(userByEmailQuery, ['reader@example.test']);
```

Factories return queries synchronously. Inputs come from their function parameters;
results come from `sql<Row>` and the return mode. For related inputs, use a typed
object and `db.run(operation, [{ email, active }])`. `run` always takes an input
array, including `[]` for a parameterless factory. Options belong to the definition.

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
including arrays, JSON, dates, and `undefined` becoming SQL null. Cast standalone
parameter expressions in projections (for example, select a bound value with
`::integer`) so PostgreSQL determines the intended result type.

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

Executable query tokens cannot be nested; use fragments for composition. For SQL loaded from a file
or another trusted source, use `unsafeSql<Row>(text, values)`, with an explicit
array even when empty. Never concatenate application input into SQL text.
Each public query executes one statement, including parameterless queries.

## Composing queries

`sql.fragment` creates a reusable piece of authored SQL. `sql.join` combines a
nonempty list of fragments with an explicit fragment separator. Neither declares
a result type or executes by itself.

```ts
const tenant = sql.fragment`tenant_id = ${tenantId}`;
const active = sql.fragment`active = ${true}`;
const query = sql<UserSummary>`
  SELECT id, email FROM public."User"
  WHERE ${sql.join([tenant, active], sql.fragment` AND `)}
  ORDER BY id LIMIT ${limit}
`;
```

This example assumes your table has a `tenant_id` column. The checker can resolve
these constant fragments and the literal join list. Parenthesize groups explicitly:

```ts
const group = sql.fragment`(${left} OR ${right})`;
```

SQL operator precedence is unchanged.

You can also build lists at runtime:

```ts
const filters = [sql.fragment`tenant_id = ${tenantId}`];
if (email !== undefined) filters.push(sql.fragment`email = ${email}`);

const query = sql<UserSummary>`
  SELECT id, email FROM public."User"
  WHERE ${sql.join(filters, sql.fragment` AND `)}
`;
```

Values remain bound parameters, even when they contain SQL-looking text. Strings
such as `'DESC'` also bind as values. For ordering, choose fragments containing
`DESC` or `ASC` from application-controlled alternatives. `identifier()` quotes
application-approved names; it does not authorize access.

The SafeQL preset deliberately reports runtime-built lists and conditional
fragments as unsupported. Prefer a static SQL predicate such as
`(${email}::text IS NULL OR email = ${email})` when it fits the query. Otherwise,
retain an explicit result annotation and use a narrow, explained ESLint suppression
with database tests covering each variant. Parameter safety alone does not verify
the selected columns or the correctness of every branch.

Empty fragments and `sql.join([], separator)` throw. Decide explicitly what an
empty filter list means; Tenon will not silently remove a condition. Separators
must be fragments, and full `sql`/`unsafeSql` queries cannot be inserted as fragments.
Each use receives correctly ordered parameters; literal `$1` text inside SQL
strings and comments is left intact. Do not author manual parameter placeholders
inside templates.

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

## Result typing with SafeQL

Recommended for TypeScript projects: generate and check query annotations against
your development/test database. This is optional development tooling, configured
by the application. The runtime does not import ESLint or SafeQL, contact a schema
service, or run a checker before executing queries.

The supported tooling setup uses TypeScript 6, SafeQL 5.4.2+, ESLint 10, and
typescript-eslint 8. Runtime consumer types are also tested with TypeScript 7;
the linting preset is tested with TypeScript 6.

```sh
npm install --save-dev typescript@~6.0.2 eslint@^10 typescript-eslint@^8 @ts-safeql/eslint-plugin@^5.4.2
```

Add this to `eslint.config.mjs`, merging with your existing configuration:

```js
import { tenonSafeql } from '@kequtech/tenon-orm/safeql';

export default [
  ...tenonSafeql({
    databaseUrl: process.env.DATABASE_URL,
    tsconfigRootDir: import.meta.dirname,
  }),
];
```

Supply `DATABASE_URL` using your application's environment setup. The preset
requires an explicit URL and does not load `.env`. Apply migrations to the intended
development/test database before checking. It defaults to `src/**/*.ts` and
`./tsconfig.json`; override `files` and `project` if needed. Use the Tenon preset in
place of a separate SafeQL configuration for those same files.

Add scripts to the application:

```json
{
  "scripts": {
    "sql:check": "eslint \"src/**/*.ts\"",
    "sql:fix": "eslint \"src/**/*.ts\" --fix"
  }
}
```

Write a query without its result annotation:

```ts
const query = sql`SELECT id, email FROM public."User" WHERE id = ${id}`;
```

Run `npm run sql:fix`. SafeQL writes an annotation such as
`sql<{ id: number; email: string }>` based on the connected schema. It can also
repair an incorrect annotation. Review the changes, run TypeScript and application
tests, and commit the result. Without an annotation, Tenon's fields remain `unknown`.

Use `npm run sql:check` in CI without `--fix`: missing/incorrect annotations,
invalid SQL, and unsupported composition fail the check without rewriting files.
ESLint's fix command can apply other enabled rules too. After a schema change,
first inspect why a query fails rather than automatically accepting a new type.

The preset recognizes Tenon's `sql` export, including import aliases and namespace
imports. It checks constant fragments and `sql.join` with literal arrays, including
nested fragments. Literal `identifier()` names and const string names are supported.
Fragments bind string, number, boolean, bigint, null/undefined values and supported
primitive arrays during static analysis; more complex parameter types should go in
the outer `sql` template. Mutable references, runtime lists, conditional fragments,
function-generated fragments, and dynamic identifiers produce explicit diagnostics.
An imported fragment must have an inspectable source initializer; declarations alone
cannot describe its SQL. It does not execute application code to discover SQL.

The preset supplies scalar mappings for bigint/numeric strings, unknown JSON, and
`Date | number` temporal values (including infinities). For recursive arrays, use
column overrides matching generated types, for example:

```js
tenonSafeql({
  databaseUrl: process.env.DATABASE_URL,
  overrides: {
    columns: { 'User.tags': 'PgArray<string>', 'User.amounts': 'PgArray<number>' },
  },
});
```

Import `PgArray` from generated definitions in files using that annotation. Numeric
arrays use numbers with pg's default parser, even though numeric scalars use strings.
Array dimensions/null elements, custom parsers, and unverified PostgreSQL types need
appropriate overrides and database tests; a checker cannot infer your parser policy.
Column keys are `Table.column`, so duplicate table names across schemas need care.
Type overrides merge with the preset's defaults. `unsafeSql` is outside static
checking, and arbitrary JSON still needs application validation.

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
