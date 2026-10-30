# API and CLI reference

For a complete first setup, follow [Getting started](human-guide.md). Task guides explain
[queries](sql.md), [writes](mutations.md), [schema types](schema-types.md),
[migrations](migrations.md), and [connections](connections.md).

## Installation and connection

Requires Node.js 24+, PostgreSQL 16+, and ESM. TypeScript consumers need TypeScript 6+ and Node.js
development typings. Install `@kequtech/tenon-orm`; pgclear is included as a runtime dependency.

```text
createTenon({ connection, onQuery? }): Database
```

`connection` is required: a PostgreSQL URI string, pgclear `PoolOptions`, or an existing pgclear
`Pool`. `Connection` names this union; `ConnectionOptions` aliases `PoolOptions`. A supplied pool
retains application ownership. Unknown Tenon or driver configuration options reject.

The returned `Database` provides:

| Member                   | Contract                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `query(query, options?)` | Execute a Tenon `SqlQuery` and apply result/count options                                |
| `transaction(callback)`  | Commit on callback success, roll back on an escaping error; return the callback's result |
| `generateTypes(options)` | Write or check schema declarations using this instance's pool/codecs                     |
| `native`                 | The underlying pgclear pool                                                              |
| `close({ timeoutMs? }?)` | Disable the wrapper and close an owned pool; default grace 5,000 ms                      |

`onQuery(event)` observes completed Tenon query calls. It may return void or a promise; it is not
awaited. Observer failures emit warnings without changing the outcome. `QueryEvent` contains
`durationMs`, `outcome: 'success' | 'error'`, and optional `label`, `command`, `rowCount`, and
`errorCode`. SQL and values are excluded. Validation failures before execution are not observed.

See [connection configuration and shutdown](connections.md) for pool settings, TLS, environment
handling, timeout bounds, and lifecycle examples. Runtime `search_path` is independent of tooling
`namespace` options.

### Driver updates

The dependency range is `@kequtech/pgclear: ^0.3.0`. Compatible patches may be updated independently;
see [driver updates](connections.md#update-the-driver). Tenon re-exports `builtin`, `json`, `param`,
`defaultCodecs`, and `createTemporalCodecs`, with the driver's `Codec`, `CodecRegistry`, `Parameter`,
`PgArray`, `TemporalConstructors`, and `TemporalInput` types.

## Queries and result modes

`sql<Row>` is a template tag returning `SqlQuery<Row>` with readonly `text` and `values`. It does
not execute. `Row` describes one selected record; without it, fields are `unknown`. Neither result
annotations nor generated types validate data during execution.

`db.query` and `tx.query` accept `{ returns?, affectedRows?, label? }`. Unknown options reject.
A supplied label must be a nonblank string.

| `returns`          | Output             | Allowed returned rows |
| ------------------ | ------------------ | --------------------- |
| `native` (default) | `QueryResult<Row>` | Any                   |
| `many`             | `readonly Row[]`   | Any                   |
| `oneOrNone`        | `Row \| undefined` | Zero or one           |
| `one`              | `Row`              | Exactly one           |

`QueryResult` follows pgclear and includes `rows`, `rowCount`, `command`, `commandTag`, and `fields`.
`rowCount` is `number | null`, independent of `RETURNING`; unsafe integer counts reject. SQL
`count(*)` is a column value and defaults to string. Row arrays are readonly.

Modes do not add `LIMIT` or `RETURNING`. Returned-row mismatches throw `CardinalityError`; alone,
that does not undo an autocommitted write. For write bounds that roll back, use `affectedRows`.

`QueryClient` is the query-only interface accepted by either a `Database` or callback `Transaction`.
Other exported types include `QueryOptions`, `QueryReturnMode`, `QueryOutput<Row, Mode>`,
`SqlQuery`, `SqlFragment`, and `UnknownRow`.

### Adapting transactional results

For an adapter expecting `{ rows }`, execute its trusted SQL through the callback's `tx`:

```ts
import { unsafeSql, type QueryClient } from '@kequtech/tenon-orm';

async function queryRows(tx: QueryClient, text: string, values: readonly unknown[]) {
  const result = await tx.query(unsafeSql(text, values));
  return { rows: [...result.rows] };
}
```

The copy supplies a mutable array if the adapter requires one. Values must already be valid driver
inputs; external arrays/objects need type-aware `param`, `json`, or text encoding. Await adapter
work inside the callback. Native pool queries use another checkout and do not join it.

For a job-library transaction adapter such as pg-boss's, verify actual SQL inputs and timestamp
expectations. Enqueueing and returning an ID may need no output conversion; returned timestamps
follow the database-wide codecs. Keep atomic commit/rollback tests. Tenon provides no per-query
codec override, and input encoders are independent of output codecs.

## SQL parameters and identifiers

| API                            | Contract                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `sql<Row>` template tag        | Bind ordinary values; interpolate Tenon fragments and identifiers structurally |
| `identifier(...names)`         | Quote components separately, e.g. `"public"."users"`                           |
| `unsafeSql<Row>(text, values)` | Trusted external SQL with an explicit values array, including `[]`             |
| `json(value, type?)`           | Encode JSON; default type is jsonb                                             |
| `param(value, codec, format?)` | Choose an explicit driver parameter type and encoder                           |

Do not quote interpolations or mix manual `$n` placeholders into templates. Plain binds accept null,
string, finite number, bigint, boolean, valid Date, supported Temporal values, and Uint8Array.
Undefined, plain objects/arrays, nonfinite numbers, and unsafe integer numbers reject.

Strings, numbers, bigint, Date, and supported Temporal values use server type inference. Date
encodes in UTC. Cast standalone parameters when PostgreSQL needs type context. Use `json` for JSON
and `param` for PostgreSQL arrays/custom encodings. Do not mutate bound values before settlement.

Identifier components require 1–63 UTF-8 bytes and no NUL. Choose approved names; quoting is not
authorization. SQL syntax such as `DESC` belongs in fixed fragments or query alternatives. Never
concatenate request input into `unsafeSql` text.

A query executes one statement through the extended protocol. Tenon does not expose a prepared
statement cache or query `name` option. See [writing queries](sql.md) for examples.

## SQL fragments and joins

- `sql.fragment` creates immutable partial SQL with bound values. It has no row type and
  cannot execute alone. Blank fragments reject.
- `sql.join(fragments, 'AND' | 'OR' | ',')` requires a nonempty array of fragments. It does not add
  parentheses or alter precedence.
- Nested/repeated fragments preserve ordered parameters. Full `sql`/`unsafeSql` queries cannot be
  nested. Literal `$1` text in SQL strings/comments is not rewritten.

See [composition examples](sql.md#compose-sql-fragments), including the empty-filter case.

## Object-based mutation fragments

```text
sql.insertValues<Input>(rowOrRows, columns?): SqlFragment
sql.assignments<Input>(patch, columns?): SqlFragment
```

These build fragments, not complete statements. Keep table, predicates, expressions, conflict
behavior, and `RETURNING` in authored SQL.

| Cell                          | Insert          | Assignment      |
| ----------------------------- | --------------- | --------------- |
| Missing or undefined          | `DEFAULT`       | Omitted         |
| Null                          | Bound SQL NULL  | Bound SQL NULL  |
| Other accepted value          | Bound parameter | Bound parameter |
| SQL fragment/identifier/query | Rejected        | Rejected        |

Inputs must be plain objects, including null-prototype objects. Only own data properties are read;
selected accessors reject. Helpers capture fields at construction; mutable bound values must remain
unchanged until execution settles.

Without `columns`, inserts infer the union of enumerable keys with defined values in first-seen
order. Assignments use own enumerable keys and omit undefined values. Explicit columns must be
nonempty, unique, and valid identifiers; they select/order keys and ignore unlisted properties.
TypeScript checks selected names against known input keys. Selection can discard required values.

A single default-only insert emits `DEFAULT VALUES`. Empty batches reject; multiple default-only
rows need explicit columns. Empty assignments always reject. There is no expression/default
sentinel; author `column = DEFAULT` or arithmetic in SQL. The complete query's limit is 65,535
parameters; Tenon does not split batches. See [writing data](mutations.md).

## Transactions, guarded writes, and errors

```ts
await db.transaction(async (tx) => {
  await tx.query(sql`UPDATE public.users SET active = false WHERE id = ${42}`, {
    affectedRows: { exact: 1 },
  });
});
```

Use `tx` for every participating query and await all work. The callback commits on success, rolls
back on an escaping error, and its client expires when the callback finishes. Transactions belong
to one database instance. Calling the root `db` uses the pool, not the callback session.

Tenon owns BEGIN/COMMIT/ROLLBACK; direct boundary statements are rejected. `tx` provides no nested
transaction method. Manual savepoints are supported on the callback session. To choose isolation,
issue `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` before data queries; use
`SET LOCAL statement_timeout = '5s'` to bound statements in that transaction.

A write guard is exactly one of `{ exact: n }` or `{ max: n }`, with a nonnegative safe integer.
It checks the final INSERT/UPDATE/DELETE/MERGE count, independently of `RETURNING`:

| Call                                | Guard behavior                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `db.query(query, { affectedRows })` | Wrap in a transaction; roll back the operation on a guard/result/SQL failure |
| `tx.query(query, { affectedRows })` | Wrap in a savepoint; roll back that operation before rejecting               |

A caught guarded failure permits continued work. An unguarded PostgreSQL error normally leaves the
transaction aborted; let it escape so the callback rolls back. Tenon serializes whole guarded
operations within a transaction, including savepoint handling.

Counts exclude extra trigger/cascade and CTE effects and cannot identify the wrong single row.
Sequence advances and external effects may survive rollback. There are no automatic retries. A lost
COMMIT acknowledgment can leave the outcome unknown; the application owns retry/idempotency policy.

| Error                               | Code and fields                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `CardinalityError`                  | `TENON_CARDINALITY_MISMATCH`; `expected` (`one` or `oneOrNone`), `actual` returned rows, optional `label`                       |
| `AffectedRowsError`                 | `TENON_AFFECTED_ROWS_MISMATCH` or `TENON_AFFECTED_ROWS_UNSUPPORTED`; `expected` constraint, `actual: number \| null`, `command` |
| Tenon option/composition validation | Ordinary `Error`                                                                                                                |
| Driver/server failure               | Native details, including driver `PGCLEAR_*` codes or PostgreSQL SQLSTATE                                                       |
| Work and cleanup both fail          | May be an `AggregateError`                                                                                                      |

Use codes and structured fields rather than matching message text. Retain unexpected failures.

## Generated types and checking

```text
db.generateTypes({ out, namespace?, check?, onWarning? }): Promise<void>
generateDefinitions({ connection, namespace?, onWarning? }): Promise<string>
```

`out` is required for file generation. Namespace defaults to `public`; `check` defaults to false.
Generation inherits the database registry. Missing/stale output rejects under `check: true` without
writing. See [schema types and values](schema-types.md) for file guarantees, generated shapes,
value mappings, codecs, and domain validation. The standalone `tenon generate` command was removed;
use an application script.

### Application aliases

Export aliases such as `UserRow = Database['users']['row']` in a handwritten file. See
[application aliases](schema-types.md#application-aliases).

### Persistence and domain values

Generated types describe storage representations. Validate JSON, text refinements, and domain
values at the application boundary; see [the worked example](schema-types.md#persistence-and-domain-values).

### Insert and update inputs

Generated types account for defaults, identity/computed columns, domains, and nullability. See
[insert/update rules](schema-types.md#insert-and-update-inputs).

## Choosing a validation tool

Use the intended development/test schema and role. TypeScript itself needs no connection.

| Tool                                     | Question answered                                                              | Main limit                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `tsc --noEmit`                           | Does application code satisfy TypeScript contracts?                            | Does not inspect SQL/schema                                     |
| `tenon check [file.ts[:line]]`           | Does recoverable SQL contradict declared input/result types?                   | Unsupported sites fail; inconclusive properties remain unproven |
| `tenon describe query.sql`               | What metadata does PostgreSQL report for finished SQL?                         | Does not compare annotations or bind values                     |
| `db.generateTypes({ out, check: true })` | Does committed output match generation now?                                    | Does not check queries or replace migration status              |
| Database tests                           | Do exercised queries produce correct rows, effects, permissions, and rollback? | Cover only tested inputs and paths                              |

After schema changes, migrate the test database, regenerate/review declarations, and run typechecks,
applicable source checks, and database tests. In CI, check generated output without replacing it.
Source checking and inspection parse/analyze application SQL without executing it; analysis can
take locks. Neither proves actual bound values or write effects.

## Source-aware checking

`checkQueries(options)` is exported from `@kequtech/tenon-orm/check`, alongside its public types.
The bundled TypeScript compiler loads only through that path or the check command.

Options are `{ connection, target?, project?, session?, timeouts?, codecs?, readTypes? }`.
Connection is a URI. The report contains `ok`, `project`, `queries`, `diagnostics`, and available
inspection `context`. Mismatches, unchecked sites, and no sites fail; unproven findings alone do not.
See [query checking](query-checking.md) for selection, supported composition, and custom decoders.

## Query inspection

```text
describeQuery({ connection, query, session?, timeouts?, codecs? }): Promise<QueryDescription>
```

Connection is a URI; query is finished SQL text or `{ text, parameterTypes? }`. A `SqlQuery` fits
because it has `text`; values and its row annotation are not checked. The report includes
`parameters`, `columns`, `rowType`, `issues`, and `context`. It uses a separate session with bounded
timeouts. See [query inspection](query-inspection.md) for fields and finding codes.

## Native driver access

`db.native` is the actual pgclear pool. Calls bypass Tenon's guards and observations and do not join
callback transactions. Use `queryClassic` for text; native `query` accepts only pgclear's own SQL
tag. See [native driver features](connections.md#use-native-driver-features) for session ownership,
prepared statements, and dedicated notification listeners.

## Troubleshooting

| Symptom                                      | Response                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL is required`                   | Supply the variable to CLI commands. No `.env` files are loaded automatically. Application configuration is explicit.                                        |
| `PGCLEAR_ENCODE`                             | Check inputs: objects/arrays need `json`/`param`; direct undefined, unsafe integers, nonfinite numbers, and invalid Dates reject. JSON still rejects bigint. |
| `CardinalityError`                           | Check the expected row count and predicate. To choose one of several rows, author deterministic `ORDER BY ... LIMIT 1`.                                      |
| `TENON_AFFECTED_ROWS_MISMATCH`               | The guarded operation rolled back. Inspect `actual` and the predicate; retain the intended bound.                                                            |
| `TENON_AFFECTED_ROWS_UNSUPPORTED`            | The final command lacks a supported write count. Use guards on INSERT/UPDATE/DELETE/MERGE; result modes check returned rows.                                 |
| Empty assignments                            | All selected fields were missing/undefined. Skip the update or branch to an expression-only statement.                                                       |
| Duplicate result columns                     | Alias columns uniquely, especially in joins. The driver rejects duplicate object keys.                                                                       |
| SQLSTATE `42P18` / `42P08` during inspection | Add the intended parameter cast or Describe OID hints. Inspection binds no values.                                                                           |
| Checker reports `unchecked`                  | Follow the diagnostic. Runtime fragments and optional patches can execute correctly yet remain unsupported by source recovery.                               |
| Missing/stale generated output               | Check schema, namespace, registry, driver version, and path. Regenerate, review, and commit intended output.                                                 |
| Migration history conflict                   | Restore original applied files. Add new changes in a forward migration. Checksums include down SQL too.                                                      |
| Tooling lock wait                            | Check concurrent migration/DDL work, use direct or session pooling, and configure server timeouts.                                                           |

After a guarded query rejects, savepoint cleanup has finished. An unguarded server error normally
aborts a transaction. A timeout or lost connection does not itself establish whether a commit
happened; review the transaction contract before adding retries.

## Command reference

All database commands read `DATABASE_URL`. `new` and `--help` work offline. No environment files
are loaded. Paths resolve from the working directory; unsupported command flags reject.

```text
tenon new <name> [--directory migrations]
tenon migrate [--directory migrations] [--namespace public]
tenon status [--directory migrations] [--namespace public]
tenon rollback [--directory migrations] [--namespace public] [--steps 1]
tenon baseline capture [--directory migrations] [--namespace public] [--schema name ...]
tenon baseline adopt [--directory migrations] [--namespace public]
tenon check [file.ts[:line]] [--project tsconfig.json] [--json]
  [--role name] [--search-path value] [--time-zone value]
  [--connect-timeout-ms 3000] [--statement-timeout-ms 5000] [--lock-timeout-ms 1000]
tenon describe <query.sql> [--role name] [--search-path value] [--time-zone value]
  [--connect-timeout-ms 3000] [--statement-timeout-ms 5000] [--lock-timeout-ms 1000]
```

| Command                | Output and behavior                                               |
| ---------------------- | ----------------------------------------------------------------- |
| `new`                  | Paths of the new empty up/down pair; fill before applying         |
| `migrate` / `rollback` | Completed IDs or “nothing to do”; each file commits independently |
| `status`               | JSON `{ applied, pending }`; validates history                    |
| `baseline capture`     | Writes a reviewed schema-only baseline using native `pg_dump`     |
| `baseline adopt`       | Records baseline history without executing its SQL                |
| `check`                | Diagnostics/counts, or a structured report with `--json`          |
| `describe`             | JSON metadata, including unresolved findings                      |

Successful commands exit 0. Invalid input or a failed operation exits 1. `check` also exits 1 for
mismatches, unchecked sites, or no sites; unproven findings alone do not fail. `describe` can exit 0
with unresolved findings. There is no migration dry-run command.

Programmatic runner APIs are [documented with migrations](migrations.md#programmatic-api).
Baseline APIs and prerequisites are in [adoption](adoption-guide.md#baseline-api).
