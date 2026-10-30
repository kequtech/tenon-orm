# Tenon reference

Exact API contracts and limitations. The [human guide](human-guide.md) introduces the workflow; the
[agent guide](agent-guide.md) covers routine implementation. Examples below use the `public.users`
table from the human guide and an existing `db` instance, unless stated otherwise.

## Installation and connection

Requires Node.js 24+, PostgreSQL 16+, and ESM. TypeScript consumers need TypeScript 6+ and Node
development typings. Tenon includes pgclear 0.3.x as a runtime dependency. A usual Node TypeScript
setup uses `module: "NodeNext"`.

```sh
npm install @kequtech/tenon-orm
```

Use `sql` from `@kequtech/tenon-orm` for `db.query`. Tenon also re-exports Pgclear's `json`,
`param`, `builtin`, `defaultCodecs`, and `createTemporalCodecs`, plus the `Codec`, `CodecRegistry`,
`Parameter`, `PgArray`, `TemporalConstructors`, and `TemporalInput` types. These are the driver's
original helpers and types; Pgclear continues to own conversion. Generated schema declarations
import their helper types from Tenon.

`createTenon({ connection, onQuery? })` returns a `Database` with `query`, `transaction`, `generateTypes`,
`native`, and `close`. The required `connection` accepts a PostgreSQL URI, pgclear `PoolOptions`, or an existing
pgclear `Pool`, borrowed by identity. `ConnectionOptions` aliases pgclear's `PoolOptions`.

```ts
const db = createTenon({
  connection: {
    connectionString: connection,
    maxConnections: 10,
    idleTimeoutMs: 30_000,
    connectTimeoutMs: 5000,
    acquireTimeoutMs: 5000,
    startupParameters: { search_path: 'app,public' },
  },
});
```

Configuration follows pgclear. Object fields override URI settings. Environment variables, pgpass,
service files, and `.env` files are not loaded by the driver; pass credentials and deployment
configuration explicitly. An explicit `{}` uses pgclear's localhost/current-user defaults. Use
`startupParameters` for session settings and `tls` for verified TLS. Unknown options reject.
See the installed pgclear public API documentation for driver configuration.

Reuse an instance for each database configuration. `db.close({ timeoutMs? })` immediately rejects
new Tenon calls and delegates owned resource shutdown to pgclear. The default grace period is
5,000 ms; `0` requests immediate shutdown. Remaining work and checkouts expire at the deadline.
Timeout must be an integer from 0 to 2,147,483,647 milliseconds. Shutdown waits for owned driver
resources, not arbitrary JavaScript callbacks or proof of remote rollback.

The first valid close call fixes its timeout; concurrent and later calls share its promise and
outcome. Invalid initial options reject without closing. For borrowed pools, close disables the
Tenon wrapper while the application retains pool ownership and outstanding work.

Qualify SQL names or configure runtime `search_path`. CLI `--namespace` selects tooling scope;
it does not configure application queries. Baseline capture and Describe accept connection strings
rather than the runtime connection union.

### Driver updates

Tenon declares `@kequtech/pgclear: ^0.3.0`, allowing compatible 0.3.x patch updates without a new
Tenon release. With npm, run `npm update @kequtech/pgclear`, review the lockfile and run
`npm ls @kequtech/pgclear`, and commit the resolved dependency change after application checks.
An existing lockfile keeps its selected version until updated. A future Pgclear 0.4 release is outside this
range and needs an explicit Tenon compatibility update; it is not an automatic upgrade.

Install Pgclear directly only when the application imports its native APIs, such as `listen` or
`createPool`. Keep that version compatible with Tenon's declared range to allow a shared copy. If
both SQL tags are needed, alias the native one as `pgSql`: Tenon's tag belongs in `db.query`, while
Pgclear's tag belongs in native `query`. Native `queryClassic(text, values)` avoids a second tag.
TypeScript and runtime validation reject sending one package's query to the other package's API.

## Native driver access

`db.native` is the actual pgclear `Pool`, readonly in TypeScript. Native calls bypass Tenon's result
modes, affected-row guards, SQL checks, and `onQuery`. They do not join a Tenon callback transaction;
callback clients expose only `tx.query`.

Use `queryClassic(text, values?)`, `acquire`/`withSession`, `prepare`, streams, and COPY through pgclear's
public APIs. Held sessions must be released. Use pgclear `listen` for a dedicated notification
connection with explicit reconnect and lifecycle policy. Notifications have no replay.

Pgclear's native `query` accepts only its own `sql` tag results. Tenon's `sql` and `unsafeSql` results
belong in `db.query`; use `queryClassic` for finished SQL text at the native boundary.

```ts
import { listen } from '@kequtech/pgclear';

const listener = await listen(connection, {
  channels: ['users_changed'],
  onNotification: ({ payload }) => console.log(payload),
  reconnect: true,
});
// At application shutdown:
await listener.close();
```

Close owned pools through `db.close()`. A separate listener has its own lifetime; close it explicitly.
Borrowed pools remain usable until their owner calls `pool.close()`.

## Queries and result modes

`sql<Row>` creates a detached `SqlQuery<Row>` with SQL `text` and ordered `values`; it does not
execute. `Row` declares one selected row. Without an annotation, fields are `unknown`. An annotation
does not verify the SQL or validate returned data.

```ts
const user = await db.query(
  sql<{ id: number; email: string }>`SELECT id, email FROM public.users WHERE id = ${42}`,
  { returns: 'oneOrNone', label: 'user-by-id' },
);
```

`query` options are `{ returns?, affectedRows?, label? }`; unknown keys fail. A supplied `label`
must be a nonempty string.

| `returns`          | Output                           | Allowed returned rows |
| ------------------ | -------------------------------- | --------------------- |
| `native` (default) | `QueryResult<Row>` driver object | Any                   |
| `many`             | `readonly Row[]`                 | Any                   |
| `oneOrNone`        | `Row \| undefined`               | Zero or one           |
| `one`              | `Row`                            | Exactly one           |

Native results expose `rows`, `rowCount`, `command`, `commandTag`, and `fields`, following pgclear's
`QueryResult`. Counts are `number | null`; row arrays are readonly. Counts outside JavaScript's safe
integer range reject instead of rounding. SQL `count(*)` is an int8 column value and reads as a string.
`rowCount` is the command's affected-row count, independent of `RETURNING`; it can be null for
commands without a count. Result modes never add `LIMIT` or `RETURNING`. A returned-row mismatch
alone does not undo an autocommitted write; use `affectedRows` for write bounds that roll back.

Functions accepting `QueryClient` can use either `Database` or `Transaction`. Public types also
include `QueryOptions`, `QueryReturnMode`, and `QueryOutput<Row, Mode>`.

### Adapting transactional results

For a job library or other adapter expecting `{ rows }`, extract the native result's row array:

```ts
import { unsafeSql, type QueryClient } from '@kequtech/tenon-orm';

async function queryRows(tx: QueryClient, text: string, values: readonly unknown[]) {
  const result = await tx.query(unsafeSql(text, values));
  return { rows: [...result.rows] };
}
```

Alternatively, request `{ returns: 'many' }` and copy the returned array into `{ rows: [...rows] }`. Supply the
callback's `tx` when the adapter's work must commit with application writes. A native pool query
uses a separate checkout and does not join that transaction. Await adapter calls before returning
from the callback, retain commit/rollback tests, and make recording helpers return pgclear native
results. The adapter's SQL text must be trusted and values must remain separately bound. This
example assumes values are already valid Tenon inputs: external JavaScript arrays and objects need
explicit, type-aware `param(value, codec)`, `json(value)`, or text encoding at the adapter boundary.
Output codecs do not select input encoders.

Callback transactions inherit the database's codecs. Passing a transaction adapter to pg-boss lets
pg-boss author job SQL and execute it through that same transaction; the application's changes and
job changes commit or roll back together. Pg-boss's own connection handles independent operations.
Enqueueing a job and returning its ID needs no timestamp conversion. When adapter calls return job
timestamps, handle them using the configured representation or convert the relevant fields at the
application boundary before code expects Date behavior. Tenon keeps codecs database-wide and does
not offer per-query overrides; a separate pool or `db.native` query does not join the transaction.

## SQL parameters and identifiers

Ordinary `sql` interpolations bind values. Do not quote them or write manual `$n` placeholders
inside templates. Plain parameters accept null, string, finite number, bigint, boolean, Date,
supported native/polyfilled Temporal values, and Uint8Array. Undefined, plain objects, arrays,
invalid Date values, nonfinite numbers, and unsafe integer numbers reject.
Use pgclear `json(value)` for JSON and `param(value, codec)` for arrays or custom encodings.
Encoded strings also work where PostgreSQL accepts text. Cast standalone parameters when SQL must
establish their type. For int8, use exact strings, bigint, or `param(text, builtin.int8)`.

Date values encode in UTC. Date, bigint, and supported Temporal inputs encode as text with OID 0,
using server inference; they do not select an output decoder. Temporal calendar dates, wall times,
instants, and durations have different PostgreSQL targets. Use the intended value and SQL cast,
rather than treating every temporal value as an interchangeable timestamp. Pgclear does not install
Temporal or a polyfill automatically.

```ts
import { builtin, param } from '@kequtech/tenon-orm';

const ids = param([1, 2, 3], builtin.int4Array);
const query = sql<{ id: number }>`SELECT id FROM public.users
  WHERE id = ANY(${ids}::integer[])`;
```

`identifier(schema, table)` quotes components separately. Names must contain 1–63 UTF-8 bytes and no
NUL. Choose application-approved names; quoting does not authorize access. SQL syntax such as `DESC`
belongs in fixed query alternatives or fragments, not a string parameter.

`unsafeSql<Row>(text, values)` accepts trusted external SQL and an explicit values array, including
`[]`. Never concatenate request input into its text. Full `sql` and `unsafeSql` queries cannot be
nested; use fragments for partial SQL.

Each Tenon query executes one statement through the extended protocol. Application execution uses
unnamed queries without a `name` or prepared-statement cache. Values remain bound separately.
Migrations deliberately support multi-statement scripts.

## SQL fragments and joins

`sql.fragment` creates immutable partial SQL with bound values. It has no row type, cannot execute
alone, and rejects blank SQL. Insert it into a complete `sql<Row>` query.

`sql.join(fragments, separator)` requires a nonempty list. Separators are `'AND'`, `'OR'`, and
`','`. It does not add parentheses or change SQL precedence. Each fragment use receives correctly
ordered parameters, including repeated and nested uses; literal `$1` text in strings/comments is
unchanged.

```ts
const email: string | undefined = 'reader@example.test';
const conditions = [sql.fragment`active = ${true}`];
if (email !== undefined) conditions.push(sql.fragment`email = ${email}`);
const query = sql<{ id: number }>`SELECT id FROM public.users
  WHERE ${sql.join(conditions, 'AND')} ORDER BY id`;
```

The mandatory predicate keeps the list nonempty. If every filter is optional, choose a complete
query without `WHERE` for the empty case. Group mixed `AND`/`OR` expressions explicitly.

## Object-based mutation fragments

`sql.insertValues(input, columns?)` and `sql.assignments(input, columns?)` return fragments. Keep
operation, table, predicates, expressions, conflict policy, and `RETURNING` in SQL:

```ts
const query = sql<{ id: number }>`INSERT INTO public.users
  ${sql.insertValues({ email: 'reader@example.test' })} RETURNING id`;
await db.query(query, { returns: 'one' });
await db.query(sql`UPDATE public.users SET ${sql.assignments({ active: false })} WHERE id = ${42}`);
```

Both accept plain objects, including null-prototype objects. Columns are quoted as individual
identifiers. Only own data properties are read; accessors are rejected. Fields are captured at
fragment construction; bound values retain pgclear encoding rules and must remain unchanged until settlement.

| Input                                        | Insert                 | Assignment      |
| -------------------------------------------- | ---------------------- | --------------- |
| Missing or `undefined`                       | `DEFAULT` for the cell | Omitted         |
| `null`                                       | Bound SQL null         | Bound SQL null  |
| Other value                                  | Bound parameter        | Bound parameter |
| SQL fragment, identifier, or query as a cell | Rejected               | Rejected        |

Inserts accept one object or an array. Without `columns`, they infer the union of enumerable keys
with defined values in first-seen order. Heterogeneous rows stay aligned. A single default-only row
emits `DEFAULT VALUES`. Empty batches fail; multiple default-only rows need explicit columns.
Assignments omit undefined values and fail when no assignments remain, even if surrounding SQL has
other assignments.

A supplied column list must be nonempty, unique, and valid. It selects and orders fields, ignoring
unlisted keys. Missing insert cells use defaults; missing update fields are omitted. TypeScript
checks selected names against known input keys, but selection can still discard required fields.
Helpers have no schema metadata; PostgreSQL enforces identity, generated-column, and constraint
rules. Use [generated inputs](#insert-and-update-inputs) and application validation.

Write arithmetic, `column = DEFAULT`, and `excluded.column` in the surrounding SQL. There is no
expression/default sentinel. A complete query accepts at most 65,535 bound parameters, including
surrounding interpolations; Tenon does not split batches. See the [mutation cookbook](mutations.md).

## Transactions, guarded writes, and errors

For an existing user with id 42:

```ts
await db.transaction(async (tx) => {
  await tx.query(sql`UPDATE public.users SET active = false WHERE id = ${42}`, {
    affectedRows: { exact: 1 },
  });
});
```

Use `tx` for every operation that must commit together and await the work. The callback commits on
success, rolls back on an escaping error, and expires before cleanup. Transactions belong to one
database instance. Nested callbacks and automatic retries are not provided. pgclear owns
BEGIN/COMMIT/ROLLBACK and recovery.

`affectedRows: { exact: n }` or `{ max: n }` accepts a nonnegative safe integer. It checks the final
INSERT/UPDATE/DELETE/MERGE count independently of `RETURNING`. A guarded root call uses a
transaction; a guarded callback call uses a savepoint. Failed checks and other errors from that
guarded operation roll it back before throwing. A caught guarded failure permits continued work;
unguarded SQL errors normally abort the transaction.

Counts exclude extra trigger/cascade and CTE effects and cannot identify the wrong single row.
Sequence advances and external effects are not reversible. A lost commit acknowledgment can leave
the outcome unknown; applications own retry and idempotency policy.

Set isolation before data queries with `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`, and use
`SET LOCAL statement_timeout = '5s'` to bound statements in that transaction. Manual savepoints are
supported on the owned callback session; pgclear chooses guarded-operation savepoints.

SQL errors retain native driver details. Tenon's option/composition validation throws ordinary
`Error` objects; driver encoding failures retain `PGCLEAR_*` codes.
`CardinalityError` has code `TENON_CARDINALITY_MISMATCH`, `expected` (`one` or `oneOrNone`),
`actual` (returned row count), and optional `label`. It does not change transaction or autocommit
behavior. `AffectedRowsError` carries `expected`, `actual`, `command`, and code
`TENON_AFFECTED_ROWS_MISMATCH` or `TENON_AFFECTED_ROWS_UNSUPPORTED`; its `actual` is `number | null`.
Work/cleanup failures can produce `AggregateError`.

Optional `onQuery` observes completed calls with `label`, `durationMs`, `outcome`, and available
`command`, `rowCount` (`number | null`), and `errorCode`. It receives no SQL or values. Validation
failures before execution are not observed. Observers are not awaited; failures emit warnings without changing the
query outcome. Query success inside a callback does not establish outer commit.

## Generated types and checking

`db.generateTypes({ out, namespace?, check?, onWarning? })` reads schema catalogs, renders
TypeScript declarations, and writes or checks an output file using the instance's existing pool and
configured codecs. `GenerateTypesOptions` is exported. It returns `Promise<void>` and emits no
progress messages. It is available on `Database`, not on a callback `Transaction`; call it outside
transactions after migrations have committed.

```ts
await db.generateTypes({ out: 'src/generated-schema.d.ts' });
await db.generateTypes({ out: 'src/generated-schema.d.ts', check: true });
```

`out` is required and resolves from the working directory. The default namespace is `public`,
independent of runtime `search_path`; pass the schema explicitly when it differs. `check` defaults
to false. Generation creates parent directories and replaces the complete file atomically, cleaning
up temporary files on failure. With `check: true`, missing/stale output rejects with a bounded diff
for stale files, without creating directories or rewriting output. Other filesystem errors propagate.
`onWarning` may be synchronous or asynchronous; it defaults to `console.warn`. Generation rejects
if warning handling fails and leaves the existing output intact. Calls after `db.close()` reject;
borrowed pools remain application-owned.

Generation interprets defaults, domains, identities, writable columns, and schema summaries,
coordinates with the migration advisory lock, and excludes its history table. It needs no migration
files/history. `generateDefinitions({ connection, namespace?, onWarning? })` remains available for
callers needing the source string without file handling; supply the application's configured pool
or connection options to preserve its read representations.

Run generation from an [application-owned script](human-guide.md#generate-types), for example
`npm run db:generate` and `npm run db:check-types`. The standalone `tenon generate` command has been
removed because it could not inherit application codecs. Commit exact output and exclude it from
formatting. Freshness checking does not check query annotations, pending migrations, or every
database object. Upgrading pgclear can change output without schema drift. Preserve reviewed
generator-specific references for existing adoption guards; see
[baseline verification](adoption-guide.md#check-and-adopt-an-existing-database).

The generated module exports `Database[table]['row' | 'insert' | 'update']`. Ordinary tables and
partitioned roots are included. Views, foreign tables, and attached partitions need authored types.
Relationships, indexes, constraints, and referenced domains appear in comments. Use `Pick` for
projections; joins and expressions need their actual selected shape.

| PostgreSQL type                                | Default read                    | Generated write input                 |
| ---------------------------------------------- | ------------------------------- | ------------------------------------- |
| smallint, integer, oid, real, double precision | `number`                        | `number`                              |
| bigint                                         | `string`                        | `string \| bigint`                    |
| numeric                                        | `string`                        | `string \| bigint`                    |
| boolean                                        | `boolean`                       | `boolean`                             |
| text, UUID, timetz                             | `string`                        | `string`                              |
| date, timestamp, timestamptz                   | `string`                        | `string \| Date \| TemporalInput`     |
| time, interval                                 | `string`                        | `string \| TemporalInput`             |
| enum                                           | String literal union            | Same union                            |
| json/jsonb                                     | `unknown`                       | Encoded string or pgclear `Parameter` |
| bytea                                          | `Uint8Array`                    | `Uint8Array`                          |
| Supported built-in arrays                      | Recursive readonly `PgArray<T>` | Encoded string or pgclear `Parameter` |

Every writable generated field also accepts a pgclear `Parameter`; the scalar entries above show
plain inputs. SQL NULL is separate; nullable fields add null. Numeric and bigint arrays preserve
exact strings, and temporal strings retain precision and infinity spellings. Dynamic enum/domain/extension
arrays remain wire text unless a decoder changes them. Generation follows the selected registry.
Custom text codecs can declare `text.typescript`, and those expressions are preserved in generated
row types. A custom decoder without a known representation warns and becomes unknown. JSON member
shapes remain unknown under default decoding. Database constraints and textual formats still
require application validation. A scalar codec declaration describes every use of that codec's OID;
it does not establish different application meanings for individual columns.

Default-registry enum rows use catalog label unions. With a custom registry, a declared string
representation stays string because that decoder may transform the labels; an explicit codec
representation can declare a narrower output type. Enum write inputs retain the database choices.

`db.generateTypes` uses the registry configured on the database instance. Regenerate committed
definitions after a driver mapping change before running freshness checks with `check: true`;
custom decoder types that remain unknown need application-owned contracts.
Catalog queries use default result decoders on the same borrowed session and snapshot, while
application row types follow that session's configured registry. Custom application codecs therefore
do not change the generator's own metadata-reading types.

Codec type expressions must resolve where they are compiled. Relative import expressions in saved
declarations resolve from the generated file; the checker's in-memory module resolves from the
tsconfig directory. Prefer a package or configured type alias that resolves in both places when one
registry is shared across generation and checking. Tenon does not execute the referenced modules.

Output conversions are explicit: for example, `defaultCodecs.with(builtin.int8BigInt)` makes int8
reads bigint, and `defaultCodecs.with(builtin.timestamptzDate)` makes timestamptz reads Date.
Pgclear also supplies codecs for caller-provided Temporal implementations. Use the same registry for
execution, programmatic generation, Describe, and query checking. Defaults stay strings regardless
of which temporal features the runtime provides.

### Application aliases

For shorter names, export aliases from a handwritten application module such as `src/schema-types.ts`:

```ts
import type { Database } from './generated-schema.js';

export type UserRow = Database['users']['row'];
export type UserInsert = Database['users']['insert'];
export type UserUpdate = Database['users']['update'];
```

These aliases reference the generated definitions directly and follow changes when the schema is
regenerated. Keep them in the application module so regeneration preserves your chosen names.

### Persistence and domain values

Generated types describe storage representations. Text `CHECK` constraints do not become unions, and
JSON reads remain unknown. Validate values before narrowing to application domain types.

For example, assume this additional table and regenerate `Database` from the resulting schema:

```sql
CREATE TABLE public.sessions (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
```

Use the same application validator before encoding a write and when restoring a domain value:

```ts
import { sql } from '@kequtech/tenon-orm';
import type { Database } from './generated-schema.js';

function sessionData(value: unknown): { userId: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('userId' in value) ||
    typeof value.userId !== 'string' ||
    value.userId.length === 0
  ) {
    throw new Error('Expected session data with a nonempty userId');
  }
  return { userId: value.userId };
}

function finiteDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Expected a finite database timestamp');
  }
  return date;
}

const input = {
  id: 'example-session',
  data: JSON.stringify(sessionData({ userId: 'user-42' })),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
} satisfies Database['sessions']['insert'];
await db.query(sql`INSERT INTO public.sessions ${sql.insertValues(input)}`);

const row = await db.query(
  sql<Database['sessions']['row']>`SELECT id, data, expires_at FROM public.sessions
    WHERE id = ${input.id} AND isfinite(expires_at) AND expires_at > now()`,
  { returns: 'oneOrNone' },
);
const session =
  row === undefined
    ? undefined
    : {
        id: row.id,
        data: sessionData(row.data),
        expiresAt: finiteDate(row.expires_at),
      };
```

The generated JSON read remains `unknown` and the timestamp remains `string`. The projection
validates both without assertions or edits to generated types. Preserve null separately for nullable
columns. For an authentication policy requiring finite expiry, `isfinite(expires_at)` excludes both
infinities before the expiry comparison; `expires_at > now()` alone would accept positive infinity.
Include such predicates in expiry-sensitive updates/deletes too, and test infinite and expired
values. This example illustrates representation validation; applications must also retain their
token verification, revocation, and authorization checks. See
[JSON and PostgreSQL arrays](mutations.md#json-and-postgresql-arrays) for array write boundaries.

Bigint and `count(*)` reads are exact strings. Use `BigInt(value)` for exact arithmetic; convert
to number only after checking the safe integer range. Command `rowCount` values are numbers; the
driver rejects counts outside the safe integer range.

### Insert and update inputs

```ts
import type { Database } from './generated-schema.js';

const input: Database['users']['insert'] = { email: 'reader@example.test' };
const patch: Pick<Database['users']['update'], 'active'> = { active: false };
sql.insertValues(input);
sql.assignments(patch);
```

Insert fields are required when nonnullable, writable, and without a default. Other writable insert
fields and all writable update fields are optional and accept explicit undefined, including with
`exactOptionalPropertyTypes`. Explicit null requires both column and domain-chain permission. Domain
defaults count; column defaults take precedence.

Computed and `GENERATED ALWAYS` identity columns use optional `never` fields. Serial and
`GENERATED BY DEFAULT` identities are optional on insert and writable on update; other primary keys
remain writable. Use `Pick`/`Omit` for application restrictions. Apply the generated types through
annotations, `satisfies`, or helper generic arguments; they do not validate constraints, JSON
structure, authorization, or nonempty input.

For custom representations, provide reviewed application types and encoders. Selected columns
can discard required fields; see [the cookbook](mutations.md#input-types-and-runtime-validation).

## Choosing a validation tool

Run these against the intended development/test schema and role. CLI tools use `DATABASE_URL`;
generation uses the configured database instance. TypeScript itself needs no connection.

| Tool                                     | Question answered                                                                                 | Limits                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `tsc --noEmit`                           | Does the application satisfy its TypeScript contracts?                                            | Does not inspect SQL or the live schema.                                                                             |
| `tenon check [file.ts[:line]]`           | Does recoverable authored SQL contradict its input/result declarations?                           | Unsupported composition fails as unchecked; inconclusive properties stay unproven. Does not execute application SQL. |
| `tenon describe query.sql`               | What parameter/result metadata does PostgreSQL report for this finished SQL?                      | Does not compare source annotations or validate bound values. Does not execute the statement.                        |
| `db.generateTypes({ out, check: true })` | Does saved generated output match this schema and driver mapping?                                 | Does not check query annotations or replace migration status. Use the project's actual output path.                  |
| Project database tests                   | Do representative queries produce the required rows, effects, permissions, and rollback behavior? | Cover exercised inputs and paths; retain cases for runtime-dependent composition and application validation.         |

After a schema or driver mapping change, apply migrations to the test database, regenerate and
review declarations, then run the project's typecheck, applicable source checks, and database tests.
In CI, `db.generateTypes({ out, check: true })` detects stale committed output without replacing it.

## Source-aware checking

Use tenon check [file.ts[:line]] [--project tsconfig.json] [--json] to compare authored SQL with its
TypeScript input/result contracts and pgclear Describe. A file selects all recognized queries;
a one-based line selects one complete query. The TypeScript compiler loads on the checking path.

The programmatic API is checkQueries from @kequtech/tenon-orm/check. It accepts connection, target,
project, session, timeouts, codecs and optional custom readTypes. It returns ok, project, queries,
diagnostics and available inspection context. Mismatches and unchecked sites fail; unproven types
are trusted and reported as notes. No query sites fails. See [query checking](query-checking.md) for
composition, output contracts, explicit expansion shapes and custom decoder representations.

## Query inspection

`describeQuery({ connection, query, session?, timeouts?, codecs? })` accepts a PostgreSQL URI and a finished
SQL string or `{ text, parameterTypes? }` object. It returns PostgreSQL metadata, conservative read mappings and row
declaration, session context, and coded findings. It does not bind values, execute the statement, or
verify `sql<Row>`.

Inspection owns a separate session with bounded timeouts. Match runtime settings; temporary tables
and uncommitted changes are not inherited. Read mappings use `codecs.typescript(oid)` from the selected pgclear registry; defaults apply when
omitted. Custom decoder types may remain unresolved. Nullability stays unknown. See
[query inspection](query-inspection.md) for settings, result fields, issue codes, and testing.

## Troubleshooting

Use error codes and structured fields rather than matching message wording. Driver errors have
`PGCLEAR_*` codes; PostgreSQL errors use SQLSTATE. Checker diagnostics have their own `kind` and
`code`. Retain unexpected errors instead of treating every failure as an empty query result.

| Symptom                                           | Likely cause and response                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PGCLEAR_ENCODE`                                  | A bind is unsupported, a Date is invalid, or an encoder failed. Use `json(value)` for JSON and `param(values, builtin.int4Array)` for integer arrays. Plain bigint, valid Date, and supported Temporal inputs are accepted; plain objects/arrays and direct undefined still reject. Omit undefined through a mutation helper when omission is intended. JSON encoding still rejects bigint, including nested values. |
| `CardinalityError` / `TENON_CARDINALITY_MISMATCH` | `one` received zero/multiple rows, or `oneOrNone` received multiple rows. Review the predicate and intended mode. Use deterministic `ORDER BY` plus `LIMIT 1` only when selecting one of several matches is intended. Result modes do not add limits.                                                                                                                                                                |
| `TENON_AFFECTED_ROWS_MISMATCH`                    | A write exceeded `max` or differed from `exact`. The guarded operation has rolled back. Inspect the predicate and `actual` count; retain the intended write bound.                                                                                                                                                                                                                                                   |
| `TENON_AFFECTED_ROWS_UNSUPPORTED`                 | The final command lacks a supported INSERT/UPDATE/DELETE/MERGE count. Apply the guard to a supported write; use result modes for returned-row requirements.                                                                                                                                                                                                                                                          |
| Empty assignments                                 | Every selected patch field was missing/undefined. Skip the update or branch to an expression-only statement when that is intended. Null remains a bound value.                                                                                                                                                                                                                                                       |
| SQLSTATE `42P18` / `42P08` during inspection      | PostgreSQL cannot establish an unambiguous parameter type. Add the intended SQL cast, or pass `parameterTypes` OID hints to `describeQuery`. Inspection does not bind query values.                                                                                                                                                                                                                                  |
| Query checker reports `unchecked`                 | SQL structure or an expansion shape could not be recovered, a limit was exceeded, or inspection failed. Follow the diagnostic; optional generated patch fields and dynamic fragment lists can be valid at runtime but remain unchecked. See [responding to findings](query-checking.md#responding-to-findings).                                                                                                      |
| Missing/stale generated definitions               | Check the namespace, schema, driver version, and output path. Regenerate with the same options and `check: false`, review the diff, and commit intended output. Freshness checks never rewrite the file.                                                                                                                                                                                                             |

Inside a transaction, catch a guarded query failure only after its promise rejects; savepoint
cleanup completes before rejection. An unguarded server SQL error normally leaves the transaction
failed, so let the outer callback roll it back. Encoding errors happen before dispatch, but their
inputs still need correction. A timeout or lost commit acknowledgement does not prove rollback;
see [transactions and errors](#transactions-guarded-writes-and-errors) before adding retries.

## Command reference

Database commands require `DATABASE_URL`. `new` and `--help` work offline. No environment files are
loaded. Paths are relative to the working directory. Explicit flags unsupported by a command are
rejected. The check command checks authored SQL; generated-file freshness is checked through
`db.generateTypes({ out, check: true })`. Neither is a migration dry run.

```text
tenon new <name> [--directory migrations]
tenon migrate [--directory migrations] [--namespace public]
tenon status [--directory migrations] [--namespace public]
tenon rollback [--directory migrations] [--namespace public] [--steps 1]
tenon check [file.ts[:line]] [--project tsconfig.json] [--json]
  [--role name] [--search-path value] [--time-zone value]
  [--connect-timeout-ms 3000] [--statement-timeout-ms 5000] [--lock-timeout-ms 1000]
tenon describe <query.sql> [--role name] [--search-path value] [--time-zone value]
  [--connect-timeout-ms 3000] [--statement-timeout-ms 5000] [--lock-timeout-ms 1000]
tenon baseline capture [--directory migrations] [--namespace public] [--schema name ...]
tenon baseline adopt [--directory migrations] [--namespace public]
```

`new` scaffolds empty `<numeric-id>_<name>.up.sql` and `.down.sql` files. Names contain letters,
digits, underscores, or hyphens. Fill both files or remove the down file for an irreversible change.
IDs sort numerically. Never edit applied files: checksums cover up and down SQL.

Each migration and history entry commits together; earlier files remain applied if a later one
fails. Runner search path is the selected namespace followed by `pg_catalog`. `status` returns
applied/pending IDs as JSON and rejects history conflicts. `rollback` validates that every selected
file has down SQL before executing any; `steps` is a positive safe integer. Use dollar-quoted
function bodies and explicit `E'...'` backslash escapes. Nontransactional DDL such as
`CREATE INDEX CONCURRENTLY` requires a separate procedure.

Migration/status/rollback/adoption use session advisory locks per database and namespace; generation
uses the same lock in shared mode. Use direct or session-pooled connections and server timeouts to
bound waits. Baseline capture uses a local creation lock and native `pg_dump`; it does not acquire
the runner's database advisory lock. See [adoption](adoption-guide.md).

Programmatic `migrate`, `migrationStatus`, and `rollback` accept
`{ connection, directory?, namespace? }`; rollback also accepts `steps`. Migration/rollback return
completed IDs. `createMigration({ name, directory? })` returns `{ id, upPath, downPath }`;
`readMigrations(directory?)` returns validated SQL and checksums.
