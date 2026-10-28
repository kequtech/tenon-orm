# Tenon reference

Exact API contracts and limitations. The [human guide](human-guide.md) introduces the workflow; the
[agent guide](agent-guide.md) covers routine implementation. Examples below use the `public.users`
table from the human guide and an existing `db` instance, unless stated otherwise.

## Installation and connection

Requires Node.js 24+, PostgreSQL 16+, and ESM. TypeScript consumers need TypeScript 6+ and Node
development typings. Tenon includes `pg@8.23.1` and its TypeScript declarations; no driver peer or
special compiler plugin is required. A usual Node TypeScript setup uses `module: "NodeNext"`.

```sh
npm install @kequtech/tenon-orm
```

`createTenon({ connection, onQuery? })` returns a `Database` with `query`, `transaction`, `native`,
and `close`. The required `connection` accepts:

- A PostgreSQL URI string.
- A pg `PoolConfig` object; an explicit `{}` uses the driver's environment defaults.
- An existing `pg.Pool`, borrowed by identity.

```ts
const db = createTenon({
  connection: {
    connectionString: connection,
    connectionTimeoutMillis: 5000,
    options: '-c search_path=app,public',
  },
});
```

Strings become pg's `connectionString`; configuration objects pass to `new Pool(config)`.
`ConnectionOptions` is an alias for pg's `PoolConfig`. Driver options and defaults are unchanged,
including no acquisition timeout unless `connectionTimeoutMillis` is configured. Pool timeouts use
milliseconds. pg parses the URI for connection fields; matching URI values override client
configuration, including an `options` URI parameter overriding the configuration's `options` string.
Preserve deployment credentials and TLS requirements; see
[pg connection configuration](https://node-postgres.com/features/connecting).

Reuse an instance for each database configuration. `db.close({ timeoutMs? })` immediately rejects
new Tenon work. For owned pools, accepted Tenon operations can drain for up to 5,000 ms by default;
at the deadline, remaining operations reject and Tenon requests driver termination. `0` skips the
grace period. The timeout must be an integer from 0 to 2,147,483,647 milliseconds; `CloseOptions` is
exported. This bounds Tenon's wait, not every native transport's teardown or server execution. It
sends no PostgreSQL cancellation request and does not cancel JavaScript callbacks. An unbounded
authentication attempt can keep a connection open after close resolves. Configure pg's
`connectionTimeoutMillis` when connection establishment also needs a deadline.

The first valid close call chooses the timeout. Concurrent and later calls share the same promise
and outcome. Invalid initial options reject without closing the instance. For borrowed pools, close
only disables the Tenon wrapper; the application retains the pool and outstanding work. Tenon does
not load environment files.

Qualify SQL names or configure runtime `search_path`. CLI `--namespace` selects tooling scope; it
does not configure application queries. Baseline capture and Describe accept connection strings
rather than the runtime connection union.

## Native driver access

`db.native` is the actual `pg.Pool`, readonly in TypeScript. Native calls bypass Tenon's result
modes, affected-row guards, SQL checks, and `onQuery`. They follow pg's query configuration and do
not join a Tenon transaction; callback clients expose only `tx.query`.

Use pg's [native APIs](https://node-postgres.com/apis/pool) and compatible cursor/COPY packages when
needed. For LISTEN, check out a client with `await db.native.connect()`, attach `notification` and
`error` listeners, and issue `LISTEN` on that client. Keep it checked out while listening; release
it after `UNLISTEN`. Native queued acquisitions follow pg's shutdown behavior and must be settled by
their caller before closing. A disconnected client does not reconnect. The application owns
resubscription and catch-up; notifications are not replayed.

Close owned pools through `db.close()` for bounded shutdown, including checked-out native clients.
Borrowed pools and their listeners remain usable after wrapper close until their owner ends them.

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
| `many`             | Plain `Row[]`                    | Any                   |
| `oneOrNone`        | `Row \| undefined`               | Zero or one           |
| `one`              | `Row`                            | Exactly one           |

Native results expose `rows`, `rowCount`, `command`, and `fields`, following pg's `QueryResult`.
`rowCount` is the command's affected-row count, independent of `RETURNING`; it can be null for
commands without a count. Result modes never add `LIMIT` or `RETURNING`. A returned-row mismatch
alone does not undo an autocommitted write; use `affectedRows` for write bounds that roll back.

Functions accepting `QueryClient` can use either `Database` or `Transaction`. Public types also
include `QueryOptions`, `QueryReturnMode`, and `QueryOutput<Row, Mode>`.

## SQL parameters and identifiers

Ordinary `sql` interpolations bind values. Do not quote them or write manual `$n` placeholders
inside templates. Values follow pg serialization: `null` and `undefined` bind as SQL null, arrays
bind as PostgreSQL arrays, and objects use pg's JSON serialization. For JSON input, use
`JSON.stringify(value)`, including for JSON arrays, strings, and JSON null. Generated JSON write
types accept encoded strings. Cast standalone parameters when SQL must establish their type.

```ts
const ids = [1, 2, 3];
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
fragment construction; nested objects retain ordinary driver serialization behavior.

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
database instance. Nested callbacks and automatic retries are not provided. Tenon owns direct
BEGIN/COMMIT/ROLLBACK boundaries.

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
supported; reserve names beginning with `tenon_affected_rows_` for Tenon.

SQL errors retain native driver details. Invalid inputs throw ordinary `Error` objects.
`CardinalityError` has code `TENON_CARDINALITY_MISMATCH`, `expected` (`one` or `oneOrNone`),
`actual` (returned row count), and optional `label`. It does not change transaction or autocommit
behavior. `AffectedRowsError` carries `expected`, `actual`, `command`, and code
`TENON_AFFECTED_ROWS_MISMATCH` or `TENON_AFFECTED_ROWS_UNSUPPORTED`. Work/cleanup failures can
produce `AggregateError`.

Optional `onQuery` observes completed calls with `label`, `durationMs`, `outcome`, and available
`command`, `rowCount`, and `errorCode`. It receives no SQL or values. Validation failures before
execution are not observed. Observers are not awaited; failures emit warnings without changing the
query outcome. Query success inside a callback does not establish outer commit.

## Generated types and checking

`generateDefinitions({ connection, namespace?, onWarning? })` returns TypeScript declarations from a
consistent read-only snapshot; it does not need migration files or history. The CLI writes them
atomically. Default namespace is `public`; default output is `src/generated-schema.ts`. Both `.ts`
and `.d.ts` outputs are supported. Commit exact output and exclude it from formatting.

```sh
npx tenon generate --out src/generated-schema.d.ts
npx tenon generate --out src/generated-schema.d.ts --check
```

`--check` never rewrites the file. Missing/stale output fails with a diagnostic and a short diff for
changes. It compares the generated representation, not pending migrations or every database object.
Output includes relation/constraint/index summaries and referenced domains, not function bodies,
grants, or a complete schema fingerprint.

Generation covers ordinary tables and partitioned roots. Views, foreign tables, and attached
partitions need query-specific types. A missing namespace fails; an existing empty schema is valid.
Exact table names are available through `Rows['users']`; valid nonreserved identifiers also receive
named aliases. Use `Pick` for projections; a join or aggregate needs its actual selected shape.

| PostgreSQL type                                | Read representation  | Generated write input                 |
| ---------------------------------------------- | -------------------- | ------------------------------------- |
| smallint, integer, oid, real, double precision | `number`             | `number`                              |
| bigint                                         | `string`             | `string \| bigint`                    |
| numeric                                        | `string`             | `string \| number`                    |
| boolean                                        | `boolean`            | `boolean`                             |
| text, name, varchar, char, uuid, time, timetz  | `string`             | `string`                              |
| date, timestamp, timestamptz                   | `Date \| number`     | `Date \| string`                      |
| enum                                           | String literal union | Same union; `never` for an empty enum |
| json, jsonb                                    | `unknown`            | `string` containing encoded JSON      |
| bytea                                          | `Buffer`             | `Buffer`                              |

Nullable columns add null; `unknown` already includes it. Domains retain verified base mappings and
the column's read nullability. Verified arrays use `PgArray<T> = (T | null | PgArray<T>)[]` for null
elements and multiple dimensions. Numeric arrays contain numbers and can lose precision; select/cast
them as text when exact values are required. Bigint arrays contain strings; enum arrays and arrays
of domains are unverified. Unmapped types warn and use `unknown` reads / `never` non-null writes.
Custom parsers need matching application types.

Date-only values and timestamps without time zone use Node's local timezone. Infinite temporal reads
are numbers (`Infinity` or `-Infinity`); narrow with `value instanceof Date` before date methods.
Temporal write inputs accept `Date | string`; use PostgreSQL's text `infinity` or `-infinity` when
needed.

### Persistence and domain values

Generated types describe storage representations. Text `CHECK` constraints do not become unions, and
JSON reads remain unknown. Validate values before narrowing to application domain types.

Bigint and `count(*)` reads are decimal strings. Use SQL or BigInt for exact arithmetic and decimal
strings at JSON boundaries; convert to number only when bounded or approximate values are intended.

### Insert and update inputs

```ts
import type { Rows } from './generated-schema.js';

const input: Rows.Insert['users'] = { email: 'reader@example.test' };
const patch: Pick<Rows.Update['users'], 'active'> = { active: false };
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

For unverified write mappings, provide a reviewed application-owned replacement, for example
`Omit<Rows.Insert['events'], 'delay'> & { delay: string }` for interval text input. Selected columns
can discard required fields; see [the cookbook](mutations.md#input-types-and-runtime-validation).

## Query inspection

`describeQuery({ connection, query, session?, timeouts? })` accepts a PostgreSQL URI and a finished
SQL string or `{ text }` object. It returns PostgreSQL metadata, conservative read mappings and row
declaration, session context, and coded findings. It does not bind values, execute the statement, or
verify `sql<Row>`.

Inspection owns a separate session with bounded timeouts. Match runtime settings; temporary tables,
and uncommitted changes are not inherited. Reported mappings assume pg's default parsers; parser
overrides need matching application types. Nullability stays unknown. See
[query inspection](query-inspection.md) for settings, result fields, issue codes, and testing.

## Command reference

Database commands require `DATABASE_URL`. `new` and `--help` work offline. No environment files are
loaded. Paths are relative to the working directory. Explicit flags unsupported by a command are
rejected; `--check` is only a generation check, not a migration dry run.

```text
tenon new <name> [--directory migrations]
tenon migrate [--directory migrations] [--namespace public]
tenon status [--directory migrations] [--namespace public]
tenon rollback [--directory migrations] [--namespace public] [--steps 1]
tenon generate [--namespace public] [--out src/generated-schema.ts] [--check]
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
