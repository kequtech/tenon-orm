# Tenon reference

Use this document to look up exact API behavior, query inspection, and limitations. The
[human guide](human-guide.md) teaches the workflow; the [agent guide](agent-guide.md) is a
self-contained implementation guide. [Adoption](adoption-guide.md) covers replacing an existing ORM
and transferring migration history.

## Installation and connection

Runtime requirements: Node.js 24+, PostgreSQL 16+, and ESM. The Postgres.js driver is included. TypeScript consumers need
TypeScript 6+ and Node development typings. Keep your application's strict TypeScript
setup; Tenon needs no special compiler configuration. `"type": "module"` and TypeScript's
`"module": "NodeNext"` are a usual Node setup.

```sh
npm install @kequtech/tenon-orm
```

`createTenon({ connection, onQuery? })` returns a `Database` with `query`, `transaction`, `native`, and
`close`. The required `connection` accepts a URL, Postgres.js options, or an existing Postgres.js client. An
explicit `{}` selects the driver's environment defaults. Tenon does not load environment files
automatically.

Reuse an instance per database connection. `close()` closes pools created by Tenon; supplied pools
remain application-owned. Finish outstanding work before closing. Postgres.js handles connection errors through rejected queries and its native connection callbacks.

Qualify SQL names or configure the driver's `search_path`. The CLI's `--namespace` selects the
schema used by tooling, not a runtime query namespace.

## Native driver access

`db.native` is the underlying Postgres.js client, typed as `postgres.Sql`. The property is readonly
in TypeScript. It exposes the existing pool without creating another client or requiring a separate
driver installation. A supplied client is returned by identity. Use native APIs for LISTEN, cursors,
COPY, and other driver features; their behavior follows the included `postgres@3.4.9`.

```ts
const db = createTenon({ connection });
await db.native.listen('updates', handlePayload, refreshAfterSubscription);
// At application shutdown, after outstanding work finishes:
await db.close();
```

Postgres.js LISTEN creates a dedicated physical connection alongside the query pool. Applications
own notification parsing, authorization, callback failures, and catch-up after resubscription. See
the [Postgres.js native API](https://github.com/porsager/postgres/tree/v3.4.9#listen--notify).

Native calls bypass Tenon's result contracts, affected-row guards, SQL boundary checks, and
`onQuery` observation. They use native preparation defaults. `db.native` always refers to the pool,
including inside `db.transaction`: its queries do not join that transaction. Transaction callbacks
expose only `tx.query`; use that for work that must commit or roll back together.

Native access is immediate and does not initialize Tenon's array correction. The first Tenon query
or transaction installs that correction on the shared client; already prepared native statements
can retain earlier parsers. Raw calls otherwise follow native driver behavior.

`db.close()` ends a Tenon-owned client and its native listeners. With a borrowed client, it closes
only the Tenon wrapper: native queries and listeners remain usable until their owner calls
`db.native.end()`. Calling `end()` directly also ends the client used by Tenon.

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

| `returns`          | Result                               | Returned rows allowed |
| ------------------ | ------------------------------------ | --------------------- |
| `native` (default) | Postgres.js `QueryResult<Row>` array | Any                   |
| `many`             | `Row[]`                              | Any, including zero   |
| `oneOrNone`        | `Row \| undefined`                   | Zero or one           |
| `one`              | `Row`                                | Exactly one           |

Native results are arrays of rows with `command`, `count`, `columns`, `statement`, and `state`
metadata. `count` is the affected-row count, independent of `RETURNING`; it can be null for commands
without a count. `many` returns a plain row array. Result modes never add `LIMIT` or `RETURNING`.
A returned-row mismatch does not undo an autocommitted write. Use `affectedRows` for write limits
that roll back on failure.

Reusable queries are ordinary functions. Accept a `QueryClient` and named object inputs when useful;
both `Database` and `Transaction` implement `QueryClient`. Keep result annotations on the SQL and
execution options at the query call. Public types include `QueryOptions`, `QueryReturnMode`, and
`QueryOutput<Row, Mode>`.

## SQL parameters and identifiers

The `sql` tag binds ordinary interpolations as `$1`, `$2`, etc. Never quote interpolations or author
manual parameter placeholders inside templates. Every public query executes one statement, including
parameterless queries.

Values use Postgres.js's native conversions. An undefined bound parameter is rejected. Objects and
arrays destined for JSON columns are serialized by the driver; passing pre-serialized JSON text
stores a JSON string. Arrays bound to PostgreSQL array columns retain null elements. SQL context
establishes array and JSON parameter types; cast standalone parameters to the intended SQL type.
Tenon uses the driver's raw-query path with the extended protocol so every public call executes
one statement, including calls without parameters. Application queries explicitly disable prepared
statement caching, including when the supplied driver client has `prepare: true`. Parameters remain
bound separately from SQL text.

Use an array parameter for a set of values:

```ts
const query = sql<{ id: number }>`SELECT id FROM public.users
  WHERE id = ANY(${ids}::integer[])`;
```

`identifier(schema, table)` quotes each component separately. Names must be nonempty, contain no
NUL, and fit PostgreSQL's 63-byte identifier limit. Choose names from application-approved
alternatives; quoting does not authorize access. Ordinary strings such as `'DESC'` are bound values,
not SQL syntax. For ordering, use complete query alternatives or application-selected fragments
containing `ASC` or `DESC`.

`unsafeSql<Row>(text, values)` accepts externally authored, trusted SQL and an explicit values
array, including `[]` when empty. Never concatenate request input into its text.
Full `sql` or `unsafeSql` queries cannot be inserted into other queries; use
fragments for partial SQL.

## SQL fragments and joins

`sql.fragment` creates an immutable piece of SQL with bound values. It has no row type and cannot
execute alone. Insert it into a complete `sql<Row>` query. Use fragments to share predicates or
other SQL expressions between queries. Blank fragments throw.

`sql.join(fragments, separator)` combines fragments into a new fragment. Use it when the number of
parts varies: optional filters, a condition for each search term, or a list of SQL expressions.
Write fixed structure directly in SQL. Supported separators are:

| Argument | Inserted SQL | Typical use                |
| -------- | ------------ | -------------------------- |
| `'AND'`  | `AND`        | All conditions must hold   |
| `'OR'`   | `OR`         | Any condition may hold     |
| `','`    | `, `         | Projections or assignments |

```ts
const conditions = [sql.fragment`active = ${true}`];
if (email !== undefined) conditions.push(sql.fragment`email = ${email}`);
if (afterId !== undefined) conditions.push(sql.fragment`id > ${afterId}`);

const query = sql<{ id: number }>`SELECT id FROM public.users
  WHERE ${sql.join(conditions, 'AND')} ORDER BY id`;
```

The list must be nonempty; the example keeps the active condition even when both optional filters
are absent. Joins insert separators without adding parentheses or changing SQL precedence. Group
mixed AND/OR expressions with parentheses, as in ordinary SQL.

Each fragment use receives correctly ordered parameters, including repeated and nested uses. SQL
strings and comments containing literal `$1` text are left intact.

## Object-based mutation fragments

`sql.insertValues(input, columns?)` and `sql.assignments(input, columns?)` return fragments. Keep the
operation, table, authorization predicate, conflict policy, expressions, and `RETURNING` in SQL:

```ts
const created = await db.query(
  sql<{ id: number }>`
  INSERT INTO profiles ${sql.insertValues([
    { name: 'Ada', bio: null },
    { name: 'Lin', score: 4 },
  ])}
  ON CONFLICT (name) DO NOTHING
  RETURNING id
`,
  { returns: 'many' },
);

await db.query(sql`
  UPDATE profiles SET ${sql.assignments({ name: input.name, bio: input.bio })},
    revision = revision + 1
  WHERE id = ${id} AND owner_id = ${viewer}
`);
```

Both helpers accept plain objects (including null-prototype objects), quote each column as one
identifier, and bind cell values as data. Inputs are read when the fragment is created; replacing a
field afterward does not change its captured value. Nested values retain the driver's usual
serialization behavior. Only own data properties are read; accessors are rejected.

| Input                                        | Insert behavior                    | Assignment behavior                     |
| -------------------------------------------- | ---------------------------------- | --------------------------------------- |
| Missing or `undefined` field                 | PostgreSQL `DEFAULT` for that cell | Omitted; the stored column is unchanged |
| Explicit `null`                              | Bound SQL null                     | Bound SQL null                          |
| Other value                                  | Bound parameter                    | Bound parameter                         |
| SQL fragment, identifier, or query as a cell | Rejected                           | Rejected                                |

Without `columns`, inserts infer the union of enumerable keys with defined values across all rows,
in first-seen order. Heterogeneous rows stay aligned; missing cells use `DEFAULT`. One object or a
one-row batch with no defined fields emits `DEFAULT VALUES`. An empty batch throws. A multi-row
batch with no inferred columns throws; supply explicit columns to emit multiple default rows.

Assignments infer enumerable keys and omit undefined values. An empty object or a selection with
no defined values throws, so the helper never emits an empty `SET` clause. This also applies when
the surrounding statement contains arithmetic or other assignments: branch explicitly when the
intended update consists only of those expressions.

An optional nonempty column list selects and orders fields. It does not validate that the input
object has no additional keys. Unlisted fields are ignored; missing insert cells use `DEFAULT`,
while missing update fields are omitted. Duplicate or invalid column
names throw. TypeScript checks selected names against the input's known keys:

```ts
const rows: { name: string; bio?: string | null }[] = buildRows();
const insert = sql`INSERT INTO profiles ${sql.insertValues(rows, ['name', 'bio'])} RETURNING id`;

const patch: { name?: string; bio?: string | null } = readPatch();
const update = sql`UPDATE profiles SET ${sql.assignments(patch, ['name', 'bio'])} WHERE id = ${id}`;
```

The helpers have no runtime schema metadata. Use [generated input types](#insert-and-update-inputs)
or application-owned contracts to check JavaScript values; PostgreSQL enforces identity,
generation, required-column, and constraint rules. Retain application validation.
To reset an update field to its default, write `column = DEFAULT` in the
surrounding SQL. Put arithmetic and `excluded.column` expressions there too; these helpers accept
values only, with no expression/default sentinel.

A compiled query accepts at most 65,533 bound parameters, including surrounding interpolations.
Tenon rejects larger queries and does not split them automatically. Choose batch sizes and
transaction boundaries in the caller. Helper validation errors identify invalid rows/columns
without printing cell values.

See the [mutation cookbook](mutations.md) for common patterns and
[query inspection](#query-inspection) for checking completed statements.

## Transactions, guarded writes, and errors

```ts
await db.transaction(async (tx) => {
  const id = 42;
  await tx.query(sql`UPDATE public.users SET active = false WHERE id = ${id}`, {
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

SQL errors retain Postgres.js's codes and details. Invalid inputs and returned-row mismatches throw ordinary
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
Generated files provide reusable row and mutation input types. The CLI writes that source
atomically. This command checks
the existing file without rewriting it:

```sh
npx tenon generate --out src/generated-schema.d.ts --check
```

`--check` reports a missing file or shows a short text diff when the saved output differs from the
current database. It never rewrites the file. Pending migration files
are a separate concern. The representation includes table columns, constraints, indexes, and
referenced domains, not every PostgreSQL object.

Generation reads a consistent snapshot of ordinary tables and partitioned roots. `Rows['users']`
describes one returned row. Application type names can use PascalCase:

```ts
import type { Rows } from './generated-schema.js';

type User = Rows['users'];
type UserSummary = Pick<User, 'id' | 'email'>;
```

Use `sql<User>` for a full row or `sql<UserSummary>` for that projection. Generated table keys and
named aliases preserve exact SQL names; the generated `users` alias also means `Rows['users']`.
`type AuditRow = Rows['audit-log']` works for names that cannot be exported as identifiers.
Views, foreign tables, and attached partitions use query-specific types. A missing namespace
fails; an existing empty schema is valid.

| PostgreSQL type                                | Returned value                           | Generated write input                   |
| ---------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| smallint, integer, oid, real, double precision | `number`                                 | `number`                                |
| bigint                                         | `string`                                 | `string \| bigint`                      |
| numeric                                        | `string`                                 | `string \| number`                      |
| boolean                                        | `boolean`                                | `boolean`                               |
| text, name, varchar, char, uuid, time, timetz  | `string`                                 | `string`                                |
| date, timestamp, timestamptz                   | `Date` (infinities become invalid dates) | `Date \| string`                        |
| enum                                           | String literal union                     | Same union; `never` for an empty enum   |
| json, jsonb                                    | `unknown`                                | `Exclude<JSONValue, null>` (from Tenon) |
| bytea                                          | `Buffer`                                 | `Buffer`                                |

For returned rows, nullable columns add null. Domains use verified underlying mappings and the
column's own nullability. Unverified types warn and become `unknown`. Verified arrays use
`PgArray<T> = (T | null | PgArray<T>)[]` for null elements and multiple dimensions. Numeric arrays
contain exact strings, like numeric scalars. Enum arrays and arrays of
domains are unverified. Date-only values use the driver's UTC date parsing; timestamps without time zone use Node's local timezone.
Infinite timestamps remain invalid `Date` objects: check validity before using date methods.
Custom Postgres.js parsers need matching application types.

### Insert and update inputs

The same file provides `Rows.Insert['table']` and `Rows.Update['table']` for bound write inputs.
These are ordinary TypeScript types. `--out` accepts `.ts` or `.d.ts`; the examples use `.d.ts`
because the file contains only declarations.

```ts
import type { Rows } from './generated-schema.js';

type NewProfile = Rows.Insert['profiles'];
type ProfilePatch = Pick<Rows.Update['profiles'], 'name' | 'bio'>;

const profile: NewProfile = { name: 'Ada' };
const patch: ProfilePatch = { name: undefined, bio: null };
sql.insertValues(profile, ['name', 'bio', 'score']);
sql.assignments(patch, ['name', 'bio']);
```

Insert fields are required when nonnullable and without a default. Other writable insert fields
are optional; every writable update field is optional. `undefined` requests a default on insert
and omits an assignment on update. Explicit `null` is accepted only when the column and its domain
chain permit it. Domain defaults count; column defaults take precedence.

Computed columns and `GENERATED ALWAYS` identity columns cannot receive values. Serial and
`GENERATED BY DEFAULT` identity columns are optional on insert and writable on update. Other
primary keys remain writable. Use `Pick` or `Omit` for application-specific restrictions and keep
expressions, `DEFAULT`, and special identity overrides in SQL.

Write representations in the table above also apply to verified array elements. Pass JavaScript JSON
values directly; do not pre-serialize them. A bound null is SQL null. To construct JSON null explicitly,
use SQL such as `'null'::jsonb`. Native temporal serialization requires finite dates; strings such as
`'infinity'` are not valid bound date values. Use SQL literals for these PostgreSQL values. Unverified non-null write values use `never` and warn;
nullable fields still accept null. Supply an application-owned replacement when needed, for example
`Omit<Rows.Insert['events'], 'delay'> & { delay: string }` for a reviewed interval-text input.

Apply these types through annotations, `satisfies`, or helper generic arguments such as
`sql.insertValues<NewProfile>(input)`. They check shapes and representations, not authorization,
constraints, JSON contents, or nonempty inputs. Optional fields accept explicit `undefined`,
including with `exactOptionalPropertyTypes`. Selected columns can discard required fields; see
the [cookbook example](mutations.md#input-types-and-runtime-validation).

## Query inspection

`describeQuery({ connection, query, session?, timeouts? })` accepts a PostgreSQL connection URI
and a finished SQL string or `{ text }` query object. It returns parameter/result type metadata,
source constraints, conservative row declaration, effective session context, and coded findings.
It does not bind query values, execute the inspected statement, or verify `sql<Row>`.

`tenon describe <query.sql>` prints that report as JSON using `DATABASE_URL`. Session flags are
`--role`, `--search-path`, and `--time-zone`. Timeout flags are `--connect-timeout-ms`,
`--statement-timeout-ms`, and `--lock-timeout-ms`; defaults are 3000, 5000, and 1000 ms.

Inspection owns a separate connection and uses Postgres.js mappings. Match the application's role
and settings; temporary tables, uncommitted changes, transaction-local settings, and custom parsers
are not inherited. Result nullability remains unknown. CLI exit 0 means description succeeded,
including reports with unresolved issues; execution and type annotations remain unchecked.

See [query inspection](query-inspection.md) for public types, finding codes, session behavior, and
the workflow combining inspection with persistent application database tests.

## Command reference

All database commands use `DATABASE_URL`; environment files are not loaded automatically. For
multiple databases, run commands with the intended database's URL and migration directory, and use
distinct generated output files if generating table types.

```text
tenon new <name> [--directory migrations]
tenon migrate [--directory migrations] [--namespace public]
tenon status [--directory migrations] [--namespace public]
tenon rollback [--directory migrations] [--namespace public] [--steps 1]
tenon generate [--namespace public] [--out path] [--check]
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
