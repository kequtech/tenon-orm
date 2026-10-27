# Tenon agent guide

Tenon executes PostgreSQL SQL through Postgres.js, with parameter binding, transactions, optional write
limits, SQL migrations, and generated row and mutation input types. Use ordinary functions for reusable queries.
This guide contains the setup and contracts needed for routine implementation; the
[reference](reference.md) covers additional options.

## Working conventions

1. Inspect the application's connection setup, migrations, generated types, query modules, and check
   commands. Reuse them. Do not replace a working migration runner just to use Tenon queries.
   For new schemas, prefer plural `snake_case` table names and `snake_case` column names; preserve
   existing schemas' names.
2. Write straightforward SQL with explicit selected columns. Use separate complete queries when
   variants return different shapes. Introduce fragments only for actual reuse or variable
   composition.
3. Put reusable queries in functions. Accept a `QueryClient` and named object inputs when useful;
   keep SQL and query options together. Call the same function with `db` or `tx`.
4. After SQL changes, inspect the completed queries and run typechecking and relevant database
   assertions. Cover meaningful runtime variants and verify declared result contracts against
   complete relevant rows.
5. Keep validation, authorization, retries, and parser configuration in the application. A quoted
   identifier or correct row count does not prove authorization.

## Install and connect

Requires Node.js 24+, PostgreSQL 16+, ESM, TypeScript 6+, and Node development typings. Keep the
application's strict TypeScript configuration.

```sh
npm install @kequtech/tenon-orm
```

```ts
import { createTenon } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
export const db = createTenon({ connection });
```

`connection` accepts a URL, Postgres.js options, or an existing Postgres.js client. An explicit `{}` selects the driver's
environment defaults. Reuse one instance per database connection. `close()` closes owned pools;
supplied clients remain application-owned. The driver retains its native connection callbacks. Await
outstanding work before closing. Environment files are not loaded automatically. Qualify SQL names
or configure `search_path`; CLI `--namespace` does not change runtime query names.

## Query contracts

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';
import type { Rows } from './generated-schema.js';

type Summary = Pick<Rows['users'], 'id' | 'email'>;

function userByIdQuery({ id }: { id: number }) {
  return sql<Summary>`SELECT id, email FROM public.users WHERE id = ${id}`;
}

function userById(client: QueryClient, input: { id: number }) {
  return client.query(userByIdQuery(input), { returns: 'oneOrNone' });
}

const user = await userById(db, { id: 42 });
// In a transaction, call userById(tx, { id: 42 }).
```

`sql<Row>` describes one selected row. It does not prove SQL/type agreement or validate JSON.
Unannotated fields stay `unknown`. Generated types describe full table rows; joins, aliases,
aggregates, and expressions need projection-specific types.

| `returns`          | Result                               | Row-count contract |
| ------------------ | ------------------------------------ | ------------------ |
| `native` (default) | Postgres.js `QueryResult<Row>` array | Any                |
| `many`             | `Row[]`                              | Any                |
| `oneOrNone`        | `Row \| undefined`                   | At most one        |
| `one`              | `Row`                                | Exactly one        |

`query` options are `{ returns?, affectedRows?, label? }`; unknown options fail. Return modes never
insert `LIMIT` or `RETURNING`. Returned-row checks alone do not undo autocommitted writes. `label`
is an optional nonempty diagnostic string. Native results are row arrays with `.count`, `.command`,
and `.columns`; `many` returns a plain row array.

The Postgres.js driver is included. Undefined bound parameters fail. Pass JSON values directly,
including arrays, rather than calling `JSON.stringify`. Numeric and bigint scalars and arrays read
as strings. Dates read as `Date`, including invalid dates for timestamp infinities; check validity
before using them. SQL NULL array elements read as JavaScript null.

## Parameters and composition

- Ordinary interpolations bind values. Do not quote them or author manual `$n` placeholders inside
  templates. `undefined` is rejected; use `null` for SQL null.
- PostgreSQL infers parameter types from SQL. Cast standalone projections, e.g.
  `SELECT ${value}::float8 AS value`, so inspection and execution use the same type.
- Use `id = ANY(${ids}::integer[])` for an array of IDs. Do not build a comma-separated string of
  values.
- `identifier(schema, table)` quotes separate application-approved components. Ordinary strings such
  as `'DESC'` remain bound values, not SQL syntax.
- `sql.fragment` carries SQL and bound values without a row type. Use it for shared predicates or
  partial SQL. Fragments cannot execute alone; full `sql` and `unsafeSql` queries cannot be nested.
- `sql.join(fragments, separator)` combines a variable-length list of fragments using `'AND'`,
  `'OR'`, or `','`. Use it for optional filters, search terms, or lists of SQL expressions. The list
  must be nonempty; group mixed `AND`/`OR` predicates with parentheses.
- `unsafeSql<Row>(text, values)` accepts trusted external SQL with an explicit values array. Never
  concatenate request input into its text. Each query executes one statement.

For example, share a search condition between a page and count query:

```ts
const search = sql.fragment`active = ${true} AND email ILIKE ${pattern}`;
const page = sql<Summary>`SELECT id, email FROM public.users
  WHERE ${search} ORDER BY id LIMIT ${limit}`;
const count = sql<{ count: string }>`SELECT count(*) AS count FROM public.users
  WHERE ${search}`;
```

`pattern` and `limit` are validated application inputs. See the
[composition reference](reference.md#sql-fragments-and-joins) for grouping and list examples.

## Object-based writes

Use official `sql.insertValues(rowOrRows, columns?)` and `sql.assignments(patch, columns?)` fragments
instead of application helpers that enumerate object keys. Keep tables, authorization predicates,
expressions, conflict behavior and `RETURNING` visible in SQL. Insert missing/undefined fields use
PostgreSQL defaults; update missing/undefined fields are omitted. Explicit null stays null. Empty
batches/updates throw; a single default-only insert works. Omit generated columns and batch large
writes explicitly below the query-wide limit of 65,533 parameters. Expressions and queries are
rejected as cell values; write arithmetic, `DEFAULT`, and `excluded.column` in the surrounding SQL.

Use generated `Rows.Insert['table']` and `Rows.Update['table']` for mutation inputs when available;
narrow editable fields with `Pick`. They account for defaults, nullability, domains, and generated
columns. Write mappings differ from returned rows: timestamps use `Date | string`, bigint uses
`string | bigint`, and JSON accepts native JavaScript values through Tenon's exported `JSONValue` type. See the [input types](reference.md#insert-and-update-inputs).

Selected columns choose and order fields, e.g. `sql.insertValues(rows, ['name', 'score'])`. Unlisted
fields are ignored. See the [mutation contract](reference.md#object-based-mutation-fragments) and
[cookbook](mutations.md).

## Inspect and test completed queries

Inspection ships with Tenon and needs no additional setup:

```ts
import { describeQuery } from '@kequtech/tenon-orm';

const query = userByIdQuery({ id: 42 });
const description = await describeQuery({ connection, query });
```

Pass the actual query object that will go to `db.query`, including fragments and conditional
predicates. A small ordinary query-building function can make the same statement available to
inspection and execution tests. Keep authorization policy inside the builder or shared fragments.

For a SQL file with PostgreSQL `$n` placeholders:

```sh
npx tenon describe query.sql
```

Supply `DATABASE_URL` through the application's existing environment setup. Match its role,
`search_path`, and timezone through the connection URI or optional `session` settings. Review
the returned `context`; this is a separate connection with Postgres.js read mappings. It does not
inherit custom parsers, temporary tables, or transaction-local state.

The report contains parameter/column types and findings with stable issue codes. Result nullability
is unknown, source `NOT NULL` is informational, and JSON remains unknown. CLI success means the
statement was described, not that `sql<Row>`, values, permissions, or business behavior were verified.

With a test fixture containing user 42, check the database projection and the actual value separately:

```ts
import assert from 'node:assert/strict';

assert.deepEqual(
  description.columns.map(({ name, readType }) => [name, readType]),
  [
    ['id', 'number'],
    ['email', 'string'],
  ],
);
const expected = { id: 42, email: 'reader@example.test' } satisfies Summary;
assert.deepEqual(await userById(db, { id: expected.id }), expected);
```

The builder keeps inspection and application SQL together; the query function keeps execution options
and its `db`/`tx` contract together. Keep simple queries inline when they do not need a shared builder.
The typed fixture checks the declared shape, the description checks PostgreSQL's projection, and
execution checks the actual row. None of these proves coverage of other inputs or authorization rules.

Run the same query through the real application connection against its test database. Assert full
relevant rows/effects and exercise meaningful branches: ownership, optional filters, absent joins,
empty aggregates, pagination ties, JSON validation, and failed/replayed/rolled-back writes as
applicable. Keep these tests alongside the query; describing a single instance covers only that
instance. See [query inspection](query-inspection.md) for session options, limits, and issue codes.

## Transactions and writes

Use `db.transaction(async (tx) => ...)`; use `tx` for every query in scope and await all work. The
callback commits on success and rolls back on an escaping error. Do not issue direct
BEGIN/COMMIT/ROLLBACK boundaries or use `tx` after return. Transactions do not span database
instances. Nested callback transactions and automatic retries are not provided.

Use `affectedRows: { exact: n }` or `{ max: n }` for INSERT/UPDATE/DELETE/MERGE when a write must
respect a count. Bounds are nonnegative safe integers. A guarded `db.query` uses a transaction; a
guarded `tx.query` uses a savepoint. Rejected writes are rolled back before throwing. A caught
guarded failure permits continued work; ordinary SQL failures may abort the transaction. Reserve
savepoint names beginning with `tenon_affected_rows_`.

Affected counts cover the final command, not extra trigger/cascade/CTE effects. They cannot detect
the wrong single row. Sequence advances and external effects are not reversible. A lost commit
acknowledgment may leave the outcome unknown; retry only according to application policy. Native Postgres.js
errors retain their details; `AffectedRowsError` has codes `TENON_AFFECTED_ROWS_MISMATCH` and
`TENON_AFFECTED_ROWS_UNSUPPORTED`. Cleanup failures can produce `AggregateError`.

Optional `onQuery` observes labels, duration, outcome, and available command/count/ error code,
without SQL or values. Observers are not awaited. Query success inside a callback does not mean the
outer transaction committed.

## Schema changes

Reuse the application's migration setup. With Tenon's runner and generated table types, use this
development script in `package.json`:

```json
{
  "scripts": {
    "db:migrate": "tenon migrate && tenon generate --out src/generated-schema.d.ts"
  }
}
```

```sh
npx tenon new create_users
# Fill the generated up/down SQL before migrating.
npm run db:migrate
npx tenon generate --out src/generated-schema.d.ts --check
npx tenon status
npx tenon rollback --steps 1
```

Commit migrations and generated types together. Production runs only `npx tenon migrate` and deploys
the already-built application. Omit generation from the development script if table types are
unused.

Database commands require `DATABASE_URL`. Migration commands accept `--directory` (default
`migrations`) and `--namespace` (default `public`); generation accepts `--namespace`. Files use
`<numeric-id>_<name>.up.sql` with optional matching down SQL. Omit a down file for an intentionally
irreversible migration. Never edit applied files. For a custom namespace, pass it to both commands
in the development script.

Each migration commits with its history entry; earlier files remain applied if a later one fails.
Tools use session advisory locks: use a direct connection or session pooling and application
timeouts. Nontransactional DDL needs a separate procedure. `generate --check` detects representation
drift, not pending migrations or every possible schema change. Generation covers ordinary tables and
partitioned roots; views/foreign tables need authored query types.

When replacing another ORM, preserve its schema and behavior. If transferring migration ownership,
capture one reviewed baseline with `tenon baseline capture`, record it only on matching existing
databases with `tenon baseline adopt`, and use `tenon migrate` on fresh databases. Adoption does not
compare schemas or run baseline SQL. Fresh replay omits ownership and grants; apply deployment
security provisioning before application access, especially for `SECURITY DEFINER` functions.
See [adoption](adoption-guide.md) for the full transition procedure. A down migration or schema-only
baseline is not a data backup.
