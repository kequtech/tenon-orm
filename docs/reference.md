# Tenon reference

Use this document to look up exact API behavior, checker setup, and limitations. The
[human guide](human-guide.md) teaches the workflow; the [agent guide](agent-guide.md) is a
self-contained implementation guide. [Adoption](adoption-guide.md) covers replacing an existing ORM
and transferring migration history.

## Installation and connection

Runtime requirements: Node.js 24+, PostgreSQL 16+, ESM, and `pg`. TypeScript consumers need
TypeScript 6+ and development typings for Node and `pg`. Keep your application's strict TypeScript
setup; Tenon needs no special compiler configuration. `"type": "module"` and TypeScript's
`"module": "NodeNext"` are a usual Node setup. Checker compatibility is listed separately below.

```sh
npm install @kequtech/tenon-orm pg
npm install --save-dev @types/pg
```

`createTenon({ connection, onQuery? })` returns a `Database` with `query`, `transaction`, and
`close`. The required `connection` accepts a URL, `pg.PoolConfig`, or existing `pg.Pool`. An
explicit `{}` selects pg's environment defaults. Tenon does not load environment files
automatically.

Reuse an instance per database connection. `close()` closes pools created by Tenon; supplied pools
remain application-owned. Finish outstanding work before closing. Install your own
`pool.on('error', handler)` on supplied pools; Tenon reports idle errors on owned pools through
`process.emitWarning`.

Qualify SQL names or configure the driver's `search_path`. The CLI's `--namespace` selects the
schema used by tooling, not a runtime query namespace.

## Queries and result modes

```ts
const result = await db.query(sql<Row>`SELECT ...`, {
  returns: 'many',
  label: 'list-users',
});
```

`sql<Row>` produces a `SqlQuery<Row>` with SQL `text` and ordered `values`. It does not execute.
`Row` describes one selected row; fields are `unknown` when no annotation is supplied. Type
annotations do not verify SQL or validate JSON. Full table types from generation do not
automatically describe joins or aggregates.

`query` accepts `{ returns?, affectedRows?, label? }`. Unknown options are rejected. `label` must be
a nonempty string when supplied and is used for diagnostics.

| `returns`          | Result                | Returned rows allowed |
| ------------------ | --------------------- | --------------------- |
| `native` (default) | pg `QueryResult<Row>` | Any                   |
| `many`             | `Row[]`               | Any, including zero   |
| `oneOrNone`        | `Row \| undefined`    | Zero or one           |
| `one`              | `Row`                 | Exactly one           |

Native results retain `command`, `rowCount`, `fields`, and `rows`; a null row count means none was
reported. Result modes never add `LIMIT` or `RETURNING`. A count mismatch throws; returned-row
checks alone do not undo an autocommitted write. Use `affectedRows` for write limits that roll back
on failure.

Reusable queries are ordinary functions. Accept a `QueryClient` and named object inputs when useful;
both `Database` and `Transaction` implement `QueryClient`. Keep result annotations on the SQL and
execution options at the query call. Public types include `QueryOptions`, `QueryReturnMode`, and
`QueryOutput<Row, Mode>`.

## SQL parameters and identifiers

The `sql` tag binds ordinary interpolations as `$1`, `$2`, etc. Never quote interpolations or author
manual parameter placeholders inside templates. Every public query executes one statement, including
parameterless queries.

Values use pg's conversions, including arrays, JSON, dates, and `undefined` becoming SQL null. Cast
standalone parameter projections to the intended SQL type: `SELECT ${1.5} AS value` returns text,
while `SELECT ${1.5}::float8 AS value` returns a JavaScript number. PostgreSQL infers parameter
types from SQL context.

Use an array parameter for a set of values:

```ts
const query = sql<{ id: number }>`SELECT id FROM public."User"
  WHERE id = ANY(${ids}::integer[])`;
```

`identifier(schema, table)` quotes each component separately. Names must be nonempty, contain no
NUL, and fit PostgreSQL's 63-byte identifier limit. Choose names from application-approved
alternatives; quoting does not authorize access. Ordinary strings such as `'DESC'` are bound values,
not SQL syntax. For ordering, use complete query alternatives or application-selected fragments
containing `ASC` or `DESC`; runtime-selected fragments need checker exclusions and tests.

`unsafeSql<Row>(text, values)` accepts externally authored, trusted SQL and an explicit values
array, including `[]` when empty. It bypasses static SQL checking. Never concatenate request input
into its text. Full `sql` or `unsafeSql` queries cannot be inserted into other queries; use
fragments for partial SQL.

## SQL fragments and joins

`sql.fragment` creates an immutable piece of SQL with bound values. It has no row type and cannot
execute alone. Insert it into a complete `sql<Row>` query. Constant fragments can share a predicate
between, for example, a list query and a count query. Ordinary fixed conditions are usually clearer
directly in the query.

`sql.join(fragments, separator)` combines a nonempty array of fragments into a new fragment.
Separators are exactly:

| Argument | Inserted SQL | Typical use                |
| -------- | ------------ | -------------------------- |
| `'AND'`  | `AND`        | All conditions must hold   |
| `'OR'`   | `OR`         | Any condition may hold     |
| `','`    | `, `         | Projections or assignments |

No default, arbitrary string, or fragment separator is accepted. Runtime validation also protects
JavaScript callers. A single item is returned as a new fragment without extra separators. Empty
lists and blank fragments throw; choose empty-list behavior explicitly in application code.

Joins do not add parentheses or alter SQL precedence. Group alternatives before combining them with
other conditions:

```ts
const alternatives = sql.join(
  [sql.fragment`email = ${primary}`, sql.fragment`email = ${secondary}`],
  'OR',
);
const conditions = sql.join(
  [sql.fragment`(${alternatives})`, sql.fragment`active = ${true}`],
  'AND',
);
const query = sql<{ id: number }>`SELECT id FROM public."User" WHERE ${conditions}`;
```

Each fragment use receives correctly ordered parameters, including repeated and nested uses. SQL
strings and comments containing literal `$1` text are left intact.

Static checking supports constant fragments, literal join arrays, and literal or const-string
separators. Runtime-built lists and selected fragments execute safely with respect to parameter
binding, but the checker cannot verify their SQL or result types. Prefer fixed SQL when it fits.
Otherwise keep an explicit result annotation, use a narrow explained lint suppression, and test
every variant.

## Transactions, guarded writes, and errors

```ts
await db.transaction(async (tx) => {
  const id = 42;
  await tx.query(sql`UPDATE public."User" SET active = false WHERE id = ${id}`, {
    affectedRows: { exact: 1 },
  });
  // Use tx for every query that belongs to this transaction.
});
```

Transactions belong to one database instance; they do not coordinate writes across databases. The
callback commits on success and rolls back when an error escapes. Await all work before returning;
the callback client expires afterward. A helper accepting `QueryClient` works with either `db` or
`tx`. Nested callback transactions and automatic retries are not provided.

`affectedRows: { exact: n }` requires n affected rows; `{ max: n }` permits up to n. Both require
nonnegative safe integers. Checks apply to INSERT, UPDATE, DELETE, and MERGE, independent of
`RETURNING`. A root call uses a transaction; a call on `tx` uses a savepoint. A mismatch rolls back
before throwing. You may catch a guarded failure and continue the outer transaction. Unguarded
PostgreSQL errors normally abort that transaction, even when caught.

The count covers the final command, excluding additional trigger, cascade, or CTE effects. It cannot
identify the wrong single row. Returned-row checks alone do not undo autocommitted writes. Rollback
cannot undo sequence advances or external side effects of database functions.

Set isolation and timeouts with SQL, for example `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`
before data queries and `SET LOCAL statement_timeout = '5s'`. Manual savepoints are available
through SQL; reserve `tenon_affected_rows_` names for Tenon. Direct BEGIN/COMMIT/ROLLBACK boundaries
are owned by `transaction`.

SQL errors retain pg's codes and details. Invalid inputs and returned-row mismatches throw ordinary
`Error` objects. `AffectedRowsError` carries `expected`, `actual`, `command`, and code
`TENON_AFFECTED_ROWS_MISMATCH` or `TENON_AFFECTED_ROWS_UNSUPPORTED`. When both work and cleanup
fail, `AggregateError` preserves both failures. A lost commit acknowledgment can leave the outcome
unknown; retry only when the application's operation makes that safe.

Optional `createTenon({ connection, onQuery })` observes completed calls with `label`, `durationMs`,
`outcome`, and available `command`, `rowCount`, `errorCode`. It receives no SQL or values. Observers
are not awaited; failures emit warnings. A successful callback query does not mean its outer
transaction has committed.

## Generated types and checking

`generateDefinitions({ connection, namespace?, onWarning? })` returns TypeScript source for the
connected schema. It does not need migration files or history. Table type generation is optional.
SafeQL reads the database directly and does not require these generated files; they are useful when
reusing table row shapes. The CLI writes that source atomically. This command checks the existing
file without rewriting it:

```sh
npx tenon generate --out src/generated-schema.ts --check
```

`--check` compares the generated representation with the current database. Pending migration files
are a separate concern. The representation includes table columns, constraints, indexes, and
referenced domains, not every PostgreSQL object.

Generation reads a consistent snapshot of ordinary tables and partitioned roots. Use the generated
named type in queries, for example `sql<User>`. For other table names, define an alias such as
`type AuditRow = Rows['audit-log']` and use `sql<AuditRow>`; SafeQL resolves named aliases but not
indexed access directly in `sql<Rows['audit-log']>`. Views, foreign tables, and attached partitions
use query-specific types. A missing namespace fails; an existing empty schema is valid.

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

Nullable columns add null. Domains use verified underlying mappings and the column's own
nullability. Unverified types warn and become `unknown`. Verified arrays use
`PgArray<T> = (T | null | PgArray<T>)[]` for null elements and multiple dimensions. Numeric arrays
contain numbers and can lose precision; cast to text[] for exact values. Enum arrays and arrays of
domains are unverified. Finite dates and timestamps without time zone use Node's local timezone.
Custom pg parsers need matching application types.

## SQL checking with SafeQL

SafeQL checks SQL against a real PostgreSQL schema and infers result types. ESLint runs that check
on your source files. Tenon runs the queries in the application; it does not import or run either
tool during query execution.

Configure [SafeQL normally](https://safeql.dev/api/). Tenon's optional `safeql` entry point exports
two objects:

- `safeqlPlugin` is a SafeQL plugin descriptor. Add it to each Tenon connection's `plugins` list. It
  translates constant fragments and identifiers, preserves runtime parameter behavior, and supplies
  pg result mappings. SafeQL owns database analysis and annotation fixes.
- `eslintPlugin` supplies `tenon/check-composition`. Register it in ESLint and enable the rule to
  report queries that the adapter cannot resolve, including runtime-built fragments and escaped
  outer templates.

Use both. The adapter skips unsupported queries; the companion rule makes those exclusions visible
as ordinary, individually suppressible lint errors. Neither replaces or wraps SafeQL's rule.

### Install and configure

Install the checking tools as application development dependencies, reusing the application's
existing TypeScript installation:

```sh
npm install --save-dev eslint typescript-eslint @ts-safeql/eslint-plugin
```

SafeQL and ESLint are the integration's hosts, and the adapter imports TypeScript to inspect query
expressions. They are optional peers because Tenon's database runtime does not need them.
`typescript-eslint` is an application-owned parser dependency, not a Tenon peer. Your ESLint
configuration imports SafeQL and the parser explicitly. Use a TypeScript version supported by that
lint toolchain. The `pg` driver remains Tenon's required runtime peer.

For a project with `src/**/*.ts` and a `tsconfig.json`:

```js
// eslint.config.mjs
import { defineConfig } from 'eslint/config';
import safeql from '@ts-safeql/eslint-plugin/config';
import tseslint from 'typescript-eslint';
import { safeqlPlugin, eslintPlugin } from '@kequtech/tenon-orm/safeql';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for SQL checking');

export default defineConfig({
  files: ['src/**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true },
  },
  plugins: { tenon: eslintPlugin },
  rules: { 'tenon/check-composition': 'error' },
  extends: [
    safeql.configs.connections({
      databaseUrl,
      plugins: [safeqlPlugin],
      targets: [{ tag: 'sql' }],
    }),
  ],
});
```

Add these settings to your existing ESLint setup if you have one; reuse its type-aware parser
configuration. `projectService` uses the nearest TypeScript project for each file. Supply
`DATABASE_URL` through your application's environment setup and point it at a development/test
database with migrations applied. This example does not load `.env` files.

The `.mjs` example avoids a current declaration mismatch between SafeQL's configuration helper and
ESLint's `defineConfig`. This affects configuration typechecking, not query result types.

`targets` selects the SQL tag spelling. If you alias `sql`, add the alias to the targets. For a
single database, `targets: [{ tag: { regex: '.*' } }]` selects all tags; Tenon's adapter filters
that down to actual Tenon queries, including aliases and object properties. Neither the adapter nor
the rule executes application code.

Reuse the application's lint scripts. If none exist, add these, adjusting file selection as needed.
They run all enabled ESLint rules, and `lint:fix` can change non-SQL code too:

```json
{
  "scripts": {
    "lint": "eslint \"src/**/*.ts\"",
    "lint:fix": "eslint \"src/**/*.ts\" --fix"
  }
}
```

### Generate and check annotations

Write a query without a result annotation:

```ts
const query = sql`SELECT id, email FROM public."User" WHERE id = ${id}`;
```

Run `npm run lint:fix`. SafeQL can write `sql<{ id: number; email: string }>` using the connected
schema. It can also repair an incorrect annotation. Review the changes, run TypeScript and database
tests, and commit the result. Without an annotation, Tenon's result fields stay `unknown`.

Run `npm run lint` in CI without `--fix`. Missing/incorrect annotations, invalid SQL, and
unsupported composition fail the check without rewriting files. After schema changes, run the
development [`db:migrate` script](human-guide.md#create-a-table) before checking queries. Inspect
SQL mistakes before accepting types generated from an unintended query. ESLint's fix command may
also apply other enabled rules.

### Configuration choices and multiple databases

All connection, target, and override options belong to SafeQL. There is no Tenon-specific
configuration wrapper or separate database setting. Keep `safeqlPlugin` on each Tenon connection:
without it, SafeQL does not resolve Tenon fragments and can infer different parameter types from
those returned at runtime.

For multiple databases, pass a connection array to `safeql.configs.connections`. With
`usersDatabaseUrl` and `billingDatabaseUrl` set to your development/test URLs, replace the single
connection in the setup above with:

```js
safeql.configs.connections([
  {
    databaseUrl: usersDatabaseUrl,
    plugins: [safeqlPlugin],
    targets: [{ tag: 'usersSql' }],
  },
  {
    databaseUrl: billingDatabaseUrl,
    plugins: [safeqlPlugin],
    targets: [{ tag: 'billingSql' }],
  },
]);
```

Queries can then share a file:

```ts
import { sql as usersSql, sql as billingSql } from '@kequtech/tenon-orm';

const users = usersSql`SELECT id, email FROM public.users`;
const invoices = billingSql`SELECT id, total FROM public.invoices`;
```

The aliases only select a checker connection; they are the same runtime `sql` function. Execute each
query with the correct `createTenon` instance. Neither SafeQL nor Tenon's composition rule follows
`db.query` calls to infer which database will execute a query. Keep connection targets distinct so a
query is checked against its intended database.

If queries are already separated by file, keep the `sql` tag and use an ESLint config object per
file group, each extending its own `safeql.configs.connections({ ... })`. Use non-overlapping
`files` patterns when database settings differ. Normal SafeQL configurations for other libraries can
coexist; add Tenon's adapter only to connections checking Tenon queries.

If a database has same-named tables in different schemas, qualify them in SQL, for example
`SELECT id FROM billing.accounts`. SafeQL can infer the wrong type for an unqualified table even
when the connection's `search_path` selects the correct table at execution. Explicit schema names
avoid that ambiguity.

### Supported SQL and limitations

Within the configured targets, the adapter recognizes Tenon's `sql` export through imports, local
aliases, namespace imports, and object properties that retain its TypeScript type. It checks
constant fragments and `sql.join` with literal arrays, including nested fragments. Separators must
be literal strings or const strings. Literal `identifier()` names and const string names are
supported. Values use the same parameter placeholders in static checking and execution, inside or
outside fragments. PostgreSQL infers their types from the SQL context; Tenon does not add casts
based on JavaScript types. Mutable references, runtime lists, conditional fragments,
function-generated fragments, and dynamic identifiers produce `tenon/check-composition` diagnostics.
Suppress only that rule on the particular query when runtime variants have database tests. SQL and
annotation errors still come from `@ts-safeql/check-sql`. An imported fragment must have an
inspectable source initializer; declarations alone cannot describe its SQL. It does not execute
application code to discover SQL.

Use literal line breaks in `sql` templates and bind string values with `${value}`. The composition
rule rejects JavaScript escapes such as `\n` or `\'` in the outer template: SafeQL reads raw
template text, while Tenon executes decoded JavaScript text. This diagnostic prevents checking
different SQL from what runs. Escapes inside bound values are fine; constant fragments are decoded
by Tenon's adapter before checking.

This checks SQL structure and returned-row annotations, not JavaScript input compatibility or
runtime values. For example, a boolean passed to an integer comparison is rejected by PostgreSQL at
execution, not by this lint rule. Keep typed function parameters, validate external inputs, and test
database behavior. Explicit SQL casts are checked as part of the SQL.

The adapter supplies scalar mappings for bigint/numeric strings, unknown JSON, and `Date | number`
temporal values (including infinities). For recursive arrays, use column overrides matching
generated types, for example:

```js
safeql.configs.connections({
  databaseUrl,
  plugins: [safeqlPlugin],
  targets: [{ tag: 'sql' }],
  overrides: {
    columns: { 'User.tags': 'PgArray<string>', 'User.amounts': 'PgArray<number>' },
  },
});
```

Import `PgArray` from generated definitions in files using that annotation. Numeric arrays use
numbers with pg's default parser, even though numeric scalars use strings. Array dimensions/null
elements, custom parsers, and unverified PostgreSQL types need appropriate overrides and database
tests; a checker cannot infer your parser policy. Column keys are `Table.column`, so duplicate table
names across schemas need care. Type overrides merge with the adapter's defaults. `unsafeSql` is
outside static checking, and arbitrary JSON still needs application validation.

## Command reference

All database commands use `DATABASE_URL`; environment files are not loaded automatically. For
multiple databases, run commands with the intended database's URL and migration directory, and use
distinct generated output files if generating table types.

```text
tenon new <name> [--directory migrations]
tenon migrate [--directory migrations] [--namespace public]
tenon status [--directory migrations] [--namespace public]
tenon rollback [--directory migrations] [--namespace public] [--steps 1]
tenon generate [--namespace public] [--out src/generated-schema.ts] [--check]
tenon baseline capture|adopt [--directory migrations] [--namespace public]
```

Migration filenames are `<numeric-id>_<name>.up.sql` and optional matching down files. IDs sort
numerically. Each migration and its history entry commit together; earlier files remain applied if a
later file fails. Status reports applied/pending IDs. Rollback checks that every selected file has
down SQL before executing any. Use dollar-quoted function bodies and explicit `E'...'` for backslash
escapes. Nontransactional DDL such as `CREATE INDEX CONCURRENTLY` needs a separate procedure.

Tools coordinate through session advisory locks per database/namespace. Use direct connections or
session pooling, with PostgreSQL timeouts to bound waiting.

Programmatic `migrate`, `migrationStatus`, and `rollback` accept
`{ connection, directory?, namespace? }`; rollback also accepts `steps`.
`createMigration({ name, directory? })` scaffolds files; `readMigrations(directory?)` reads
validated SQL and checksums. Baseline capture/adoption are covered in the
[adoption guide](adoption-guide.md).
