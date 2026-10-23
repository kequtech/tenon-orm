# Tenon reference

Use this document to look up exact API behavior, checker setup, and limitations.
The [human guide](human-guide.md) teaches the workflow; the [agent guide](agent-guide.md)
is a self-contained implementation guide. [Adoption](adoption-guide.md) covers
replacing an existing ORM and transferring migration history.

## Installation and connection

Runtime requirements: Node.js 24+, PostgreSQL 16+, ESM, and `pg`.
TypeScript consumers need TypeScript 6+ and development typings for Node and `pg`.
Keep your application's strict TypeScript setup; Tenon needs no special compiler
configuration. `"type": "module"` and TypeScript's `"module": "NodeNext"` are a
usual Node setup. Checker compatibility is listed separately below.

```sh
npm install @kequtech/tenon-orm pg
npm install --save-dev @types/pg
```

`createTenon({ connection, onQuery? })` returns a `Database` with `query`,
`transaction`, and `close`. The required `connection` accepts a URL, `pg.PoolConfig`,
or existing `pg.Pool`. An explicit `{}` selects pg's environment defaults. Tenon
does not load environment files automatically.

Reuse an instance per database connection. `close()` closes pools created by Tenon; supplied pools remain
application-owned. Finish outstanding work before closing. Install your own
`pool.on('error', handler)` on supplied pools; Tenon reports idle errors on owned
pools through `process.emitWarning`.

Qualify SQL names or configure the driver's `search_path`. The CLI's `--namespace`
selects the schema used by tooling, not a runtime query namespace.

## Queries and result modes

```ts
const result = await db.query(sql<Row>`SELECT ...`, {
  returns: 'many',
  label: 'list-users',
});
```

`sql<Row>` produces a `SqlQuery<Row>` with SQL `text` and ordered `values`.
It does not execute. `Row` describes one selected row; fields are `unknown` when
no annotation is supplied. Type annotations do not verify SQL or validate JSON.
Full table types from generation do not automatically describe joins or aggregates.

`query` accepts `{ returns?, affectedRows?, label? }`. Unknown options are rejected.
`label` must be a nonempty string when supplied and is used for diagnostics.

| `returns`          | Result                | Returned rows allowed |
| ------------------ | --------------------- | --------------------- |
| `native` (default) | pg `QueryResult<Row>` | Any                   |
| `many`             | `Row[]`               | Any, including zero   |
| `oneOrNone`        | `Row \| undefined`    | Zero or one           |
| `one`              | `Row`                 | Exactly one           |

Native results retain `command`, `rowCount`, `fields`, and `rows`; a null row count
means none was reported. Result modes never add `LIMIT` or `RETURNING`. A count
mismatch throws; returned-row checks alone do not undo an autocommitted write.
Use `affectedRows` for write limits that roll back on failure.

Reusable queries are ordinary functions. Accept a `QueryClient` and named object
inputs when useful; both `Database` and `Transaction` implement `QueryClient`.
Keep result annotations on the SQL and execution options at the query call.
Public types include `QueryOptions`, `QueryReturnMode`, and `QueryOutput<Row, Mode>`.

## SQL parameters and identifiers

The `sql` tag binds ordinary interpolations as `$1`, `$2`, etc. Never quote
interpolations or author manual parameter placeholders inside templates. Every
public query executes one statement, including parameterless queries.

Values use pg's conversions, including arrays, JSON, dates, and `undefined`
becoming SQL null. Cast standalone parameter projections to the intended SQL type:
`SELECT ${1.5} AS value` returns text, while `SELECT ${1.5}::float8 AS value`
returns a JavaScript number. PostgreSQL infers parameter types from SQL context.

Use an array parameter for a set of values:

```ts
const query = sql<{ id: number }>`SELECT id FROM public."User"
  WHERE id = ANY(${ids}::integer[])`;
```

`identifier(schema, table)` quotes each component separately. Names must be
nonempty, contain no NUL, and fit PostgreSQL's 63-byte identifier limit. Choose
names from application-approved alternatives; quoting does not authorize access.
Ordinary strings such as `'DESC'` are bound values, not SQL syntax. For ordering,
use complete query alternatives or application-selected fragments containing
`ASC` or `DESC`; runtime-selected fragments need checker exclusions and tests.

`unsafeSql<Row>(text, values)` accepts externally authored, trusted SQL and an
explicit values array, including `[]` when empty. It bypasses static SQL checking.
Never concatenate request input into its text. Full `sql` or `unsafeSql` queries
cannot be inserted into other queries; use fragments for partial SQL.

## SQL fragments and joins

`sql.fragment` creates an immutable piece of SQL with bound values. It has no row
type and cannot execute alone. Insert it into a complete `sql<Row>` query. Constant
fragments can share a predicate between, for example, a list query and a count query.
Ordinary fixed conditions are usually clearer directly in the query.

`sql.join(fragments, separator)` combines a nonempty array of fragments into a new
fragment. Separators are exactly:

| Argument | Inserted SQL | Typical use                |
| -------- | ------------ | -------------------------- |
| `'AND'`  | `AND`        | All conditions must hold   |
| `'OR'`   | `OR`         | Any condition may hold     |
| `','`    | `, `         | Projections or assignments |

No default, arbitrary string, or fragment separator is accepted. Runtime validation
also protects JavaScript callers. A single item is returned as a new fragment
without extra separators. Empty lists and blank fragments throw; choose empty-list
behavior explicitly in application code.

Joins do not add parentheses or alter SQL precedence. Group alternatives before
combining them with other conditions:

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

Each fragment use receives correctly ordered parameters, including repeated and
nested uses. SQL strings and comments containing literal `$1` text are left intact.

Static checking supports constant fragments, literal join arrays, and literal or
const-string separators. Runtime-built lists and selected fragments execute safely
with respect to parameter binding, but the checker cannot verify their SQL or
result types. Prefer fixed SQL when it fits. Otherwise keep an explicit result
annotation, use a narrow explained lint suppression, and test every variant.

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

Transactions belong to one database instance; they do not coordinate writes across
databases. The callback commits on success and rolls back when an error escapes. Await all
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
Table type generation is optional. SafeQL reads the database directly and does not
require these generated files; they are useful when reusing table row shapes.
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

## SQL checking with SafeQL

SafeQL checks SQL against a real PostgreSQL schema and infers result types.
ESLint runs that check on your source files. Tenon runs the queries in the
application; it does not import or run either tool during query execution.

`tenonSafeql` returns ESLint configuration that loads a Tenon-specific adapter for
SafeQL. The adapter recognizes Tenon's SQL tags and aliases, resolves supported
fragments and identifiers, and preserves the parameter placeholders Tenon sends to
PostgreSQL. It rejects forms it cannot check, including escaped outer templates.
The configuration supplies pg result mappings and a TypeScript parser, and converts
unsupported-composition failures into lint diagnostics. SafeQL performs PostgreSQL
analysis and annotation fixes; Tenon does not implement a separate result inference
engine. Use this configuration in place of a separate SafeQL rule setup for the
same files.

### Install and configure

Install SafeQL and the ESLint tools that run it on TypeScript files. Reuse an
existing ESLint setup where available. Dependency compatibility is declared in
Tenon's package metadata.

```sh
npm install --save-dev eslint typescript-eslint @ts-safeql/eslint-plugin
```

For a project with `src/**/*.ts` and `tsconfig.json` in its root:

```js
// eslint.config.mjs
import { tenonSafeql } from '@kequtech/tenon-orm/safeql';

export default tenonSafeql({
  databaseUrl: process.env.DATABASE_URL,
});
```

If you already have an ESLint configuration array, spread `...tenonSafeql(...)`
into it. Supply `DATABASE_URL` using your application's environment setup and point
it at a development/test database with your migrations applied. The URL is required;
the helper does not load `.env` or choose a database automatically.

Run commands from the project root. Reuse the application's existing lint commands.
If none exist, add these scripts. They run all enabled ESLint rules, and `lint:fix`
may change non-SQL code too:

```json
{
  "scripts": {
    "lint": "eslint \"src/**/*.ts\"",
    "lint:fix": "eslint \"src/**/*.ts\" --fix"
  }
}
```

The helper returns ESLint flat configuration; it is not a connection or an object
used by `db.query`. Its options are:

| Option            | Purpose                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `databaseUrl`     | Required development/test PostgreSQL URL.                                                                                                                                                                                              |
| `files`           | Files checked by this configuration; defaults to `['src/**/*.ts']`. Keep the command's file selection in sync.                                                                                                                         |
| `project`         | TypeScript configuration path; defaults to `'./tsconfig.json'`.                                                                                                                                                                        |
| `tsconfigRootDir` | Optional directory for resolving TypeScript project paths. For a config in the project root, `import.meta.dirname` makes this explicit if editor or monorepo path resolution needs it. This is a tooling path, not a database setting. |
| `overrides`       | SafeQL type/column mappings for application-owned pg parsers and types.                                                                                                                                                                |

### Generate and check annotations

Write a query without a result annotation:

```ts
const query = sql`SELECT id, email FROM public."User" WHERE id = ${id}`;
```

Run `npm run lint:fix`. SafeQL can write
`sql<{ id: number; email: string }>` using the connected schema. It can also repair
an incorrect annotation. Review the changes, run TypeScript and database tests,
and commit the result. Without an annotation, Tenon's result fields stay `unknown`.

Run `npm run lint` in CI without `--fix`. Missing/incorrect annotations,
invalid SQL, and unsupported composition fail the check without rewriting files.
After schema changes, apply migrations and regenerate table definitions if you use
them before checking queries. Inspect SQL mistakes before accepting types generated from an
unintended query. ESLint's fix command may also apply other enabled rules.

### Configuration choices and multiple databases

Applications can [configure SafeQL directly](https://safeql.dev/api/) using its
connection and tag-target options. This does not include Tenon's adapter behavior.
A plain `targets: [{ tag: 'sql' }]` configuration can check simple complete queries,
but cannot resolve Tenon fragments and may infer different parameter types. For
example, with default parameter handling, `SELECT ${1.5} AS v` is inferred as a
number by SafeQL while Tenon's runtime returns text. Tenon's adapter leaves
parameter types to PostgreSQL, matching execution. Result mappings and escape
handling also need attention when configuring a checker independently.

The current helper exposes a subset of SafeQL's configuration. Its adapter is
internal, not a separately exported plugin for application-owned SafeQL setups.
Do not assume a direct SafeQL configuration is equivalent to this preset.

For queries organized by database into separate files, use non-overlapping file
patterns and a URL for each group:

```js
import { tenonSafeql } from '@kequtech/tenon-orm/safeql';

export default [
  ...tenonSafeql({
    databaseUrl: process.env.USERS_DATABASE_URL,
    files: ['src/users/**/*.ts'],
  }),
  ...tenonSafeql({
    databaseUrl: process.env.BILLING_DATABASE_URL,
    files: ['src/billing/**/*.ts'],
  }),
];
```

These URLs target the corresponding development/test databases. Configure the
runtime `createTenon` instances separately. The checker does not inspect which
instance eventually receives a query, or use runtime connections to choose a schema.
Overlapping helper configurations fail ESLint's plugin merge; queries for different
databases in the same file cannot be routed by this helper. SafeQL itself supports
multiple connections with different targets, but this helper does not expose that
selection. A separately configured upstream SafeQL plugin also conflicts with
the helper's wrapped plugin if their file scopes overlap.

### Supported SQL and limitations

The preset recognizes Tenon's `sql` export through imports, local aliases,
namespace imports, and object properties that retain its TypeScript type. It checks constant fragments and `sql.join` with literal arrays, including
nested fragments. Separators must be literal strings or const strings. Literal `identifier()` names and const string names are supported.
Values use the same parameter placeholders in static checking and execution,
inside or outside fragments. PostgreSQL infers their types from the SQL context;
Tenon does not add casts based on JavaScript types. Mutable references, runtime lists, conditional fragments,
function-generated fragments, and dynamic identifiers produce explicit diagnostics.
An imported fragment must have an inspectable source initializer; declarations alone
cannot describe its SQL. It does not execute application code to discover SQL.

Use literal line breaks in `sql` templates and bind string values with `${value}`.
The preset rejects JavaScript escapes such as `\n` or `\'` in the outer template:
SafeQL reads raw template text, while Tenon executes decoded JavaScript text. This
diagnostic prevents checking different SQL from what runs. Escapes inside bound
values are fine; constant fragments are decoded by Tenon's adapter before checking.

This checks SQL structure and returned-row annotations, not JavaScript input
compatibility or runtime values. For example, a boolean passed to an integer
comparison is rejected by PostgreSQL at execution, not by this lint rule. Keep
typed function parameters, validate external inputs, and test database behavior.
Explicit SQL casts are checked as part of the SQL.

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
For multiple databases, run commands with the intended database's URL and migration
directory, and use distinct generated output files if generating table types.

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
