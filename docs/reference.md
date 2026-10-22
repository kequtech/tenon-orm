# API reference

See the [README](../README.md) for installation and [SafeQL](safeql.md) for SQL checking.

## Connection and lifetime

`createTenon({ connection, onQuery? })` is the only constructor. Connection accepts
a string, `pg.PoolConfig`, or existing `pg.Pool`. `close()` closes pools Tenon
creates, leaves supplied pools open, and rejects subsequent work. Finish outstanding
work before closing.

Tenon reports idle errors on owned pools through `process.emitWarning`; pg removes
broken clients. With a supplied pool, install your own `pool.on('error', handler)`.
Checked-out connection failures are observed between queries and broken clients
are discarded. There are no automatic retries.

Runtime clients have no schema setting. Qualify tables in SQL or configure the
connection's `search_path`. Tooling's `namespace` option is separate.

## Queries and operations

```ts
import { sql, identifier, unsafeSql, defineOperation } from '@kequtech/tenon-orm';

const id = 42;
const result = await db.query(
  sql<{ email: string }>`
  SELECT email FROM public."User" WHERE id = ${id}
`,
  { returns: 'oneOrNone' },
);
```

`sql<Row>` constructs a frozen query with `text` and `values`. Interpolations
become `$1`, `$2`, etc. Values use pg's normal conversions, including arrays,
JSON, dates, and `undefined` becoming SQL null. Do not quote interpolations or
write manual `$n` placeholders in a tagged query.

Use `identifier(schema, table)` for identifiers known by the application. Each
component is quoted separately. Ordinary interpolated strings always remain
values. Identifier quoting does not decide which tables a caller may access.
Nested query tokens and raw SQL fragments are not supported.

```ts
await db.query(sql`SELECT count(*) FROM ${identifier('public', 'User')}`);
```

`unsafeSql<Row>(text, inputs)` is the explicit escape hatch for externally authored
SQL, such as a query loaded from a file. It requires an input array, even `[]`.
Never concatenate application input into its text. SafeQL does not inspect this
path. Every execution uses extended protocol and permits only one statement.

Reusable operations contain a synchronous query factory and fixed options:

```ts
export const disableUser = defineOperation(
  (id: number) => sql`UPDATE public."User" SET active = false WHERE id = ${id}`,
  { affectedRows: { exact: 1 }, label: 'disableUser' },
);

await db.run(disableUser, [42]);
```

Input types come from the factory parameters; result types come from its query.
Factories run at execution time and should only construct a query. Importing or
defining an operation does not connect. Definitions and options are immutable;
their captured JavaScript variables remain application-owned. `run` always takes
an array and has no call-site option overrides. JavaScript callers do not receive
runtime factory-argument type or arity validation.

Both execution paths accept `OperationOptions`:

| Option         | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| `returns`      | Result shape and returned-row cardinality             |
| `affectedRows` | Optional final-command count constraint with rollback |
| `label`        | Optional nonempty diagnostic name                     |

| `returns`          | Result             | Allowed returned rows |
| ------------------ | ------------------ | --------------------- |
| `native` (default) | `QueryResult<Row>` | Any                   |
| `many`             | `Row[]`            | Zero or more          |
| `oneOrNone`        | `Row \| undefined` | Zero or one           |
| `one`              | `Row`              | Exactly one           |

Native results preserve pg metadata, including `command`, `rowCount`, `fields`,
and `rows`. A null `rowCount` means no count was reported, not zero.

The row generic describes one record, not an array. It defaults to
`UnknownRow = Record<string, unknown>`; returned rows still exist, but fields
need narrowing. Row declarations are assertions until checked against SQL.
Tenon does not validate fields or transform driver values at runtime.

`returns` never adds SQL `RETURNING` or `LIMIT`. Without `affectedRows`, a
cardinality error after an autocommitted write does not undo it.

## Affected rows and errors

`affectedRows` accepts exactly one of `{ max: n }` or `{ exact: n }`, where
`n` is a nonnegative safe integer. Zero is valid. It checks the PostgreSQL count
for the final `INSERT`, `UPDATE`, `DELETE`, or `MERGE`, independently of
`RETURNING`. Other commands or missing counts reject.

A guarded root call owns a transaction. A guarded transaction call owns a
savepoint. Count and returned-row checks happen before commit/release; failures
roll back before rejecting. You may catch a guarded error and continue the outer
transaction. Failed savepoint recovery prevents that transaction from committing.

```ts
import { AffectedRowsError } from '@kequtech/tenon-orm';

try {
  await db.run(disableUser, [42]);
} catch (error) {
  if (error instanceof AffectedRowsError && error.code === 'TENON_AFFECTED_ROWS_MISMATCH') {
    console.log(error.expected, error.actual, error.command);
  } else {
    throw error;
  }
}
```

`AffectedRowsError` extends `TenonError` and exposes:

- `code`: `TENON_AFFECTED_ROWS_MISMATCH` or `TENON_AFFECTED_ROWS_UNSUPPORTED`.
- `expected`: frozen `{ max }` or `{ exact }`.
- `actual`: the native count, or null.
- `command`: PostgreSQL's command name.

The count excludes additional trigger, cascade, and data-modifying CTE effects.
An UPDATE counts matched rows even when values stay equal. A final SELECT over
a write CTE rejects. The statement executes before checking: this is not a limit
on work, locks, or time. Rollback cannot undo sequence advances, session advisory
locks, or external effects of database functions.

Other validation/cardinality failures use `TenonError`. Native pg errors retain
their codes and details. Execution plus rollback/recovery failures preserve both
errors in an `AggregateError`. Connection loss during commit can leave the outcome
unknown; reconcile state before retrying a non-idempotent write.

## Transactions and diagnostics

`db.transaction(async tx => ...)` owns one connection, commits a successful
callback, and rolls back an escaping error. Its result resolves after commit.
Root `db` calls remain independent. Await all work before returning; the callback
client expires when the callback finishes.

Operations on a transaction client execute in submission order, including
savepoint cleanup. PostgreSQL errors on unguarded statements normally abort the
transaction even if caught. For manual recovery, use SAVEPOINT, ROLLBACK TO, and
RELEASE through `tx.query`; await the whole sequence yourself. Reserve
`tenon_affected_rows_` names for internal savepoints.

Set isolation before data queries and timeouts through PostgreSQL configuration
or explicit SQL:

```ts
await db.transaction(async (tx) => {
  await tx.query(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
  await tx.query(sql`SET LOCAL statement_timeout = '5s'`);
  // Queries and operations using tx...
});
```

Direct transaction boundaries through public queries are rejected. Nested callback
transactions, cancellation, streaming helpers, and automatic retries are absent.
Results are buffered; use SQL pagination or an explicit cursor for large reads.

`onQuery(event)` optionally observes completed execution. Events contain
`durationMs`, `outcome`, optional `label`, native `command`/`rowCount` when
available, and `errorCode` when available. They contain no SQL, input values, or
error messages. A callback statement's success does not imply the surrounding
transaction has committed. Duration includes queueing and guarded recovery;
factory and pre-dispatch validation failures do not produce events.

Observers may be synchronous or asynchronous. Tenon does not await them; observer
failures emit a warning and preserve the query outcome. Applications own log
delivery and shutdown. Keep labels free of sensitive values.

## Migrations and CLI

```text
tenon new <name> [--directory migrations]
tenon migrate [--directory migrations] [--namespace public]
tenon status [--directory migrations] [--namespace public]
tenon rollback [--directory migrations] [--namespace public] [--steps 1]
tenon generate [--directory migrations] [--namespace public]
               [--out src/generated-schema.ts] [--check]
tenon baseline capture [--directory migrations] [--namespace public]
                       [--schema name ...]
tenon baseline adopt [--directory migrations] [--namespace public]
```

After installation, use `npx tenon`; package scripts can call `tenon` directly.
Database commands read `DATABASE_URL`. Map another variable when needed:
`DATABASE_URL="$LEGACY_DATABASE_URL" npx tenon status`. Environment-file loading
belongs to application startup; Node's native support is available there.

Migration names are `<numeric-id>_<name>.up.sql`, with optional matching down
files. IDs sort numerically. `new` creates an empty pair. Each migration and its
history entry commit together; earlier files remain applied if a later one fails.
Applied up/down checksums must match the files. Add forward migrations rather
than edit applied history. Missing down SQL makes rollback unavailable.

Tools coordinate through session advisory locks in the database and namespace;
use a direct or session-pooled connection. Transaction-pooling proxies cannot
preserve those locks. PostgreSQL lock/statement timeouts control waiting.
Nontransactional DDL, including concurrent index creation, needs a separate
maintenance procedure. Migration bodies should use dollar-quoted function bodies.

Generation describes the connected schema, even with pending migrations.
`--check` compares without rewriting; it is not a migration dry run or a complete
schema-drift detector. Replaying migrations in a fresh namespace provides a check
against the intended schema. See [adoption](adopting.md) for pg_dump baselines.

Programmatic tools are `migrate`, `rollback`, `migrationStatus`,
`generateDefinitions`, `createMigration`, `readMigrations`, `captureBaseline`,
and `adoptBaseline`. Database tools accept `{ connection, directory?, namespace? }`;
`rollback` also accepts `steps`. Generation returns a source string and accepts
`onWarning`; it does not write files. Capture accepts a libpq connection string
and optional `schemas`. Public declarations describe the complete argument and
result types.

## Generated types

Generation reads a repeatable-read snapshot of ordinary tables and partitioned
roots. Output includes `Rows["exact SQL name"]`, legal named aliases, schema
comments, and applied migration IDs/checksums. It has no runtime registration.
Views, foreign tables, and attached partitions are omitted.

| PostgreSQL types                               | Default pg value     |
| ---------------------------------------------- | -------------------- |
| smallint, integer, oid, real, double precision | `number`             |
| bigint, numeric                                | `string`             |
| boolean                                        | `boolean`            |
| text, varchar, char, uuid, time, timetz        | `string`             |
| date, timestamp, timestamptz                   | `Date \| number`     |
| enum                                           | String literal union |
| json, jsonb                                    | `unknown`            |
| bytea                                          | `Buffer`             |

Nullable columns add null. Infinite dates/timestamps are numbers; finite dates and
timestamps without time zone use the Node process's local timezone. Character
padding and time strings follow pg. Floating-point values include NaN/infinities.

Verified arrays use `PgArray<T> = (T | null | PgArray<T>)[]`, preserving null
elements and multiple dimensions. The listed scalar types' arrays are covered,
except enum arrays. Numeric arrays contain numbers, unlike scalar numeric, and
can lose precision. Cast to text[] when exact numeric-array values are required.

Domains use verified underlying mappings; the column's own NOT NULL flag controls
nullability. Unknown mappings warn and become `unknown`, including enum arrays,
composites, and arrays of domains. Custom pg parsers require corresponding
application contracts. See [SafeQL](safeql.md) for matching its type overrides.
