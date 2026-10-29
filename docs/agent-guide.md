# Tenon agent guide

Tenon executes explicit PostgreSQL SQL through pgclear. Use ordinary functions for reusable queries. This
guide covers routine implementation; the [reference](reference.md) defines the full API and the
[human guide](human-guide.md) gives a step-by-step introduction.

## Start with the existing project

Read this guide after the README; consult the [reference](reference.md) for specific contracts.
For a first setup, follow the [human guide](human-guide.md). Prefer documentation from the installed
package when the repository's main branch describes a newer release.

Inspect its connection configuration, migration runner, generated types, query functions, and check
commands. Preserve those conventions. Tenon queries and type generation do not require Tenon
migration history. Keep input validation, authorization, domain conversion, and retry policy in the
application.

Start from the existing database module and a nearby query function. Reuse their connection,
generated-schema imports, namespace, and `QueryClient` convention. Check both resolved Tenon and
pgclear versions before changing driver calls or value representations.

For an upgrade, record the previous resolved Tenon version from the lockfile or installed package
and read the [Changelog](../CHANGELOG.md) entries through the target version before changing code.
It ships with the package alongside this guide. Follow its upgrade instructions, regenerate types
when mappings change, and run the project's typechecks and relevant database tests. Use the
[adoption guide](adoption-guide.md) when replacing another ORM or transferring migration ownership.

## Connect

Requires Node.js 24+, PostgreSQL 16+, ESM, TypeScript 6+, and Node development typings. Install with
`npm install @kequtech/tenon-orm @kequtech/pgclear`; retain the project's package manager and TypeScript
configuration. The supported pgclear peer starts at 0.2.0; review its release notes when upgrading
the driver independently, regenerate changed types, and rerun database checks.

```ts
import { createTenon } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
export const db = createTenon({ connection });
```

`connection` accepts a URI string, pgclear `PoolOptions` (including `connectionString`), or an existing
pgclear `Pool`. Reuse an instance for each database configuration. `db.close()` ends internally created
pools with a default 5,000 ms grace period; supplied pools remain application-owned. Configure
shutdown with `db.close({ timeoutMs })`; concurrent callers share its outcome. Finish outstanding
work before closing. Tenon loads no environment files. Qualify table names or set runtime
`search_path`; CLI `--namespace` selects tooling scope, not runtime query names. See
[connection options](reference.md#installation-and-connection).

## Query and result contracts

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';
import type { Database } from './generated-schema.js';

type Summary = Pick<Database['users']['row'], 'id' | 'email'>;

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
| `native` (default) | Driver object with `.rows`, `.rowCount`, `.fields` | Any                    |
| `many`             | `readonly Row[]`                                   | Any                    |
| `oneOrNone`        | `Row \| undefined`                                 | Zero or one            |
| `one`              | `Row`                                              | Exactly one            |

Options are `{ returns?, affectedRows?, label? }`; unknown keys fail. Modes do not add SQL limits or
`RETURNING`. A returned-row mismatch throws `CardinalityError` with code
`TENON_CARDINALITY_MISMATCH`; it alone does not undo an autocommitted write.

## Parameters and composition

- Interpolate values without quotes. Do not author `$n` placeholders inside templates. `null` binds
  SQL NULL; `undefined`, objects, arrays, and Date require omission or explicit encoding.
- Use pgclear `param(ids, builtin.int4Array)` with `ANY` for a set of IDs. Cast standalone parameters such as
  `SELECT ${value}::integer AS value` when SQL must establish the type for inspection.
- `identifier(schema, table)` quotes separate approved names. Strings such as `'DESC'` remain bound
  values; choose SQL syntax through fixed query alternatives or fragments.
- `sql.fragment` creates partial SQL with bound values; `sql.join(parts, 'AND' | 'OR' | ',')`
  combines a nonempty list. Blank fragments fail. Group mixed conditions with parentheses.
- Full `sql` or `unsafeSql` queries cannot be nested. `unsafeSql<Row>(text, values)` is for trusted
  external SQL with an explicit values array. Each Tenon query executes one statement.

Use fragments for actual reuse or variable composition. Keep fixed structure in SQL, and retain
mandatory authorization predicates when optional filters are absent.

## Writes and generated values

`sql.insertValues(rowOrRows, columns?)` builds column/value fragments;
`sql.assignments(patch, columns?)` builds assignments. Missing/undefined insert fields use defaults;
update fields are omitted. Explicit null stays null. Empty batches and empty assignments fail.
Selected columns ignore unlisted fields and can discard required inputs. Put expressions, conflict
policy, and `RETURNING` in the surrounding SQL. Batch in the caller below the query-wide
65,535-parameter limit.

Use generated `Database['users']['insert']` and `Database['users']['update']` inputs; narrow editable fields with
`Pick`. These types account for defaults, writable columns, domains, and driver representations.
They do not validate constraints or JSON contents. See [mutation examples](mutations.md).

Use pgclear `json(value)` or encoded text for JSON, and `param(value, codec)` for arrays and
custom encodings. Bigint scalars and SQL `count(*)` read as exact strings; command `rowCount` uses
numbers. Plain bigint binds reject; use strings or `param(text, builtin.int8)`. Decimals and temporal
values read as strings. Numeric and bigint arrays preserve exact strings. Bytes use Uint8Array.
SQL NULL array elements remain null. Keep domain validation at the persistence boundary. See
[value mappings](reference.md#generated-types-and-checking) and the
[JSON/temporal projection](reference.md#persistence-and-domain-values).

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
and CTE effects. pgclear owns savepoint recovery. A lost commit
acknowledgment can leave the outcome unknown.

`db.native` exposes the existing pool for driver features. Native calls bypass Tenon's guards and
`onQuery`; they do not join a Tenon transaction. Close owned pools through `db.close()`. Follow the
[native access contract](reference.md#native-driver-access) for resource ownership and LISTEN.
Optional `onQuery` reports completion metadata without SQL or values; success inside a callback does
not establish that the outer transaction committed.

## Inspect and validate

Choose the tool for the task: `tenon check` compares source contracts, `tenon describe` reports
finished SQL metadata, and `tenon generate --check` checks generated-file freshness. None replaces
TypeScript or database tests. See [validation tools](reference.md#choosing-a-validation-tool).

Run tenon check on the TypeScript project, a file, or file:line. It recovers authored SQL and types
without importing application code, then uses pgclear Describe. Mismatches, unchecked queries and
zero query sites fail; unproven properties do not. Trust declared types when metadata is inconclusive.

For checking, object expansions need an explicit finite shape type and required, defined selected
properties. Prefer explicit column lists. Fixed fragments, const aliases, fixed joins and finite
ternaries are supported within 16 variants per query. Dynamic fragments, optional-field SQL
expansion and unknown batch lengths remain unchecked. See [query checking](query-checking.md).

A generated update type usually has optional properties. Even with an explicit column list, those
properties can change the SQL by omission, so the checker may report an ordinary patch as unchecked.
Keep that runtime behavior when intended. If selected fields are always supplied, validate/narrow
the input into an explicit required shape. Do not use casts just to suppress a finding. See
[responding to findings](query-checking.md#responding-to-findings) and
[troubleshooting](reference.md#troubleshooting).

For metadata alone, use describeQuery or tenon describe query.sql. Match role, search path, timezone,
and custom codecs. Temporary tables and transaction-local state are not inherited. Retain tests for
complete rows, meaningful query variants, authorization, effects, and rollback. Describe does not
prove bound values, JSON members, nullability, cardinality or runtime execution permission.

## Schema changes

With Tenon's runner, development can use
`tenon migrate && tenon generate --out src/generated-schema.d.ts`. Commit migrations and exact
generated output together; exclude the generated file from automatic formatting. Production runs
migrations and deploys committed types. `generate --check` detects representation drift, not pending
migrations or every schema change.

All database CLI commands require `DATABASE_URL`. `tenon new <name>` creates empty up/down files
offline; fill them before migrating. Migration commands use `--directory migrations` and
`--namespace public` by default; generation also accepts `--namespace`. Pass a custom namespace to
both migration and generation. Omit the down file for an irreversible migration; never edit applied
history. Each file commits independently with its history entry. Tools use session advisory locks,
so use a direct or session-pooled connection. Nontransactional DDL needs a separate procedure. See
the [command reference](reference.md#command-reference).
