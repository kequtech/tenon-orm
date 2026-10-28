# Tenon agent guide

Tenon executes explicit PostgreSQL SQL through Postgres.js. Use ordinary functions for reusable
queries. This guide covers routine implementation; the [reference](reference.md) defines the full
API and the [human guide](human-guide.md) gives a step-by-step introduction.

## Start with the existing project

Inspect its connection configuration, migration runner, generated types, query functions, and check
commands. Preserve those conventions. Tenon queries and type generation do not require Tenon
migration history. Keep input validation, authorization, domain conversion, and retry policy in the
application.

For an upgrade, record the previous resolved Tenon version from the lockfile or installed package and read the
[Changelog](../CHANGELOG.md) entries through the target version before changing code. It ships with
the package alongside this guide. Follow its upgrade instructions, regenerate types when mappings
change, and run the project's typechecks and relevant database tests. Use the
[adoption guide](adoption-guide.md) when replacing another ORM or transferring migration ownership.

## Connect

Requires Node.js 24+, PostgreSQL 16+, ESM, TypeScript 6+, and Node development typings. Install with
`npm install @kequtech/tenon-orm`; retain the project's package manager and TypeScript configuration.

```ts
import { createTenon } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
export const db = createTenon({ connection });
```

`connection` accepts a URI string, `{ url, options? }`, Postgres.js options, or an existing driver
client. Reuse an instance for each database configuration. `db.close()` ends internally created
pools; supplied clients remain application-owned. Finish outstanding work before closing. Tenon
loads no environment files. Qualify table names or set runtime `search_path`; CLI `--namespace`
selects tooling scope, not runtime query names. See [connection options](reference.md#installation-and-connection).

## Query and result contracts

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';
import type { Rows } from './generated-schema.js';

type Summary = Pick<Rows['users'], 'id' | 'email'>;

function userById(client: QueryClient, { id }: { id: number }) {
  return client.query(sql<Summary>`SELECT id, email FROM public.users WHERE id = ${id}`, {
    returns: 'oneOrNone',
  });
}
```

`QueryClient` accepts either `db` or a transaction's `tx`. Keep SQL and execution options together.
`sql<Row>` declares one selected row; it does not verify SQL or validate data. Unannotated fields
are `unknown`. Generated table types can describe full rows or `Pick` projections; joins and
aggregates need types for their actual output.

| `returns`          | Result                                             | Required returned rows |
| ------------------ | -------------------------------------------------- | ---------------------- |
| `native` (default) | Driver array with `.count`, `.command`, `.columns` | Any                    |
| `many`             | Plain `Row[]`                                      | Any                    |
| `oneOrNone`        | `Row \| undefined`                                 | Zero or one            |
| `one`              | `Row`                                              | Exactly one            |

Options are `{ returns?, affectedRows?, label? }`; unknown keys fail. Modes do not add SQL limits
or `RETURNING`. A returned-row mismatch alone does not undo an autocommitted write.

## Parameters and composition

- Interpolate values without quotes. Do not author `$n` placeholders inside templates.
  `undefined` bound values fail; `null` means SQL null.
- Use `id = ANY(${ids}::integer[])` for a set of IDs. Cast standalone parameters such as
  `SELECT ${value}::integer AS value` when SQL must establish the type for inspection.
- `identifier(schema, table)` quotes separate approved names. Strings such as `'DESC'` remain
  bound values; choose SQL syntax through fixed query alternatives or fragments.
- `sql.fragment` creates partial SQL with bound values; `sql.join(parts, 'AND' | 'OR' | ',')`
  combines a nonempty list. Blank fragments fail. Group mixed conditions with parentheses.
- Full `sql` or `unsafeSql` queries cannot be nested. `unsafeSql<Row>(text, values)` is for trusted
  external SQL with an explicit values array. Each Tenon query executes one statement.

Use fragments for actual reuse or variable composition. Keep fixed structure in SQL, and retain
mandatory authorization predicates when optional filters are absent.

## Writes and generated values

`sql.insertValues(rowOrRows, columns?)` builds column/value fragments; `sql.assignments(patch,
columns?)` builds assignments. Missing/undefined insert fields use defaults; update fields are
omitted. Explicit null stays null. Empty batches and empty assignments fail. Selected columns
ignore unlisted fields and can discard required inputs. Put expressions, conflict policy, and
`RETURNING` in the surrounding SQL. Batch in the caller below the query-wide 65,533-parameter limit.

Use generated `Rows.Insert['users']` and `Rows.Update['users']` inputs; narrow editable fields with
`Pick`. These types account for defaults, writable columns, domains, and driver representations.
They do not validate constraints or JSON contents. See [mutation examples](mutations.md).

Pass native JSON objects/arrays rather than pre-serialized text. Bigint and numeric reads are
strings; bigint writes accept `string | bigint`. Dates read as `Date`, including invalid dates for
infinities; validate before using date methods. SQL NULL array elements are JavaScript null.
Keep domain validation at the persistence boundary. See [value mappings](reference.md#generated-types-and-checking).

## Transactions and native access

For an existing user with id 42:

```ts
await db.transaction(async (tx) => {
  await tx.query(sql`UPDATE public.users SET active = false WHERE id = ${42}`, {
    affectedRows: { exact: 1 },
  });
});
```

Use `tx` for every operation in the callback and await the work. Tenon commits on success and rolls
back on an escaping error; the callback client expires when the callback finishes. Direct
BEGIN/COMMIT/ROLLBACK boundaries, nested callback transactions, and automatic retries are not
provided. Transactions belong to one database instance.

`affectedRows: { exact: n }` or `{ max: n }` checks the final INSERT/UPDATE/DELETE/MERGE count.
Bounds are nonnegative safe integers. A guarded `db.query` uses a transaction; a guarded `tx.query`
uses a savepoint. Rejection rolls back that operation. A caught guarded failure permits continued
work; an unguarded SQL error normally aborts the transaction. Counts exclude extra trigger/cascade
and CTE effects. Reserve `tenon_affected_rows_` savepoint names for Tenon. A lost commit
acknowledgment can leave the outcome unknown.

`db.native` exposes the existing pool for driver features. Native calls bypass Tenon's guards and
`onQuery`; they do not join a Tenon transaction. Close owned clients through `db.close()`. Follow
the [native access contract](reference.md#native-driver-access) for parser initialization and LISTEN
limitations. Optional `onQuery` reports completion metadata without SQL or values; success inside
a callback does not establish that the outer transaction committed.

## Inspect and validate

Use `describeQuery({ connection, query })` on completed SQL or `tenon describe query.sql` on a file.
Inspection owns a separate connection. Match the runtime role, search path, and timezone; custom
parsers, temporary tables, and transaction-local state are not inherited. Result nullability is
unknown and JSON structure is unchecked. A successful description does not verify `sql<Row>`,
bound values, execution permission, or effects.

Pair inspection with database assertions for complete relevant rows, meaningful query variants,
and rollback. A small query-building function can share the same statement with inspection and
execution; keep simple queries inline when that is sufficient. See [query inspection](query-inspection.md).

## Schema changes

With Tenon's runner, development can use `tenon migrate && tenon generate --out
src/generated-schema.d.ts`. Commit migrations and exact generated output together; exclude the
generated file from automatic formatting. Production runs migrations and deploys committed types.
`generate --check` detects representation drift, not pending migrations or every schema change.

All database CLI commands require `DATABASE_URL`. `tenon new <name>` creates empty up/down files
offline; fill them before migrating. Migration commands use `--directory migrations` and
`--namespace public` by default; generation also accepts `--namespace`. Pass a custom namespace to
both migration and generation. Omit the down file for an irreversible migration; never edit applied
history. Each file commits independently with its history entry. Tools use session advisory locks,
so use a direct or session-pooled connection. Nontransactional DDL needs a separate procedure.
See the [command reference](reference.md#command-reference).
