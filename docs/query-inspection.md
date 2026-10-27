# Inspect and test queries

`describeQuery` asks PostgreSQL what a completed SQL statement accepts and returns, without
binding its values or executing it. Use it while writing a query or in a database test. It handles
the actual SQL produced by fragments, helpers, loops, and conditional filters.
Its `postgres` driver installs with Tenon; no extra
consumer dependency or configuration is needed. Calling inspection opens a separate connection.

## Inspect the query you will execute

```ts
import { describeQuery, sql } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');

const query = sql<{ id: number; total: string }>`
  SELECT ${42}::integer AS id, count(*) AS total FROM pg_catalog.pg_class
`;
const description = await describeQuery({ connection, query });
// description.columns reports number/string read types; nullability remains unknown.
```

For an application, pass the same query object that will go to `db.query`. Use representative inputs when calling its query-building
function. Keep authorization policy centralized inside that builder or its fragments.

`query` accepts a SQL string or an object with a `text` property, including a Tenon `SqlQuery`.
For SQL strings, use PostgreSQL placeholders such as `$1`. PostgreSQL infers their types from SQL
context; `SELECT $1::integer AS id` can be described without supplying a value. Ordinary Tenon
templates bind values with `${value}`.

Inspection does not read the type argument of `sql<Row>`, validate `query.values`, or compare an
annotation with the result. A successful description is useful schema/type evidence, not proof
that the query will execute or do the intended job.

## Match the application's context

```ts
const description = await describeQuery({
  connection,
  query,
  session: { searchPath: 'mail,public', timeZone: 'UTC' },
  timeouts: { connectMs: 3000, statementMs: 5000, lockMs: 1000 },
});
```

Reuse the application's connection URI and the source of its session settings. All overrides are
optional. Connection URI startup options are preserved. `session.role` can assume a role when the
connecting account has permission; omitted settings use the new connection's defaults. `SET ROLE`
does not load that role's login defaults. Unknown options and invalid settings fail explicitly.

The result's `context` reports the database, login/effective roles, configured and resolved search
paths, timezone, and effective server timeouts. Compare these with the execution connection.
Inspection reports `mode: 'separate-session'` and `readMappings: 'postgres'`. SQL NULL array
elements are represented as JavaScript null.

The default connection/authentication limit is 3 seconds. Every server statement, including
metadata reads, has a 5-second limit, and each lock wait a 1-second limit. Cleanup is bounded to
1 second. Timeout overrides are positive integer milliseconds; URI settings cannot disable these
bounds. Limits apply to individual operations, not one overall deadline.

The API owns and closes its connection. It does not borrow an application client or a Tenon transaction.
Temporary tables, uncommitted changes, transaction-local settings, custom parsers, and other
pool-only state are not inherited. `PGOPTIONS` environment settings are not automatically copied;
use URI startup options or explicit session values. Standard read mappings describe Postgres.js
values, so custom parser behavior needs a deliberate application decision.

## Read the result

| Field                   | Meaning                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parameters`            | Parameter type OIDs, qualified PostgreSQL type names, and Postgres.js read representations. These are not accepted JavaScript input contracts.                              |
| `columns`               | Ordered output names, PostgreSQL types, Postgres.js read representations, and source-column metadata where available.                                                       |
| `columns[].nullability` | Always `"unknown"`. A source column's `notNull` constraint does not establish result nullability.                                                                           |
| `rowType`               | A conservative `DescribedRow` TypeScript declaration. Fields include null; JSON/unmapped types stay unknown. Null when there are no output columns or names are duplicated. |
| `issues`                | Findings with stable `code` fields, human-readable messages, and relevant column/type details.                                                                              |
| `context`               | The separate inspection session's effective settings and read mapping profile.                                                                                              |

Use issue codes for tooling; message text is descriptive:

- `nullability-unknown`: result nullability has not been established.
- `shape-unknown`: listed columns have unknown read types; JSON object structure is not inferred.
- `unmapped-type`: the PostgreSQL type/OID lacks a verified Postgres.js mapping.
- `duplicate-column`: repeated names would overwrite earlier values in object rows.

Source `notNull` remains informational. Outer joins, grouping, and expressions can introduce nulls.
An empty result set supplies no runtime samples. Unknown mappings and duplicate names are findings
to handle explicitly, not a successful verification of a handwritten result type.

## CLI

Save the statement in `query.sql`, using `$1`, `$2`, and so on for parameters:

```sql
SELECT $1::integer AS id, count(*) AS total FROM pg_catalog.pg_class;
```

Supply `DATABASE_URL` through the application's normal environment setup:

```sh
npx tenon describe query.sql
npx tenon describe query.sql --search-path mail,public --time-zone UTC
```

The CLI prints the description as JSON. Options are `--role`, `--search-path`, `--time-zone`,
`--connect-timeout-ms`, `--statement-timeout-ms`, and `--lock-timeout-ms`. Migration/generation
options such as `--namespace` and `--check` are rejected. No environment files are loaded.

Exit code 0 means PostgreSQL described the statement, even if the report contains unresolved
issues. Exit code 1 means input, connection, timeout, or PostgreSQL analysis failed. No query values
are bound and no inspected statement is executed, including writes and locking statements.

## Keep execution assertions

For each meaningful query-builder variant, describe the finished SQL and run it through the
application's actual Tenon/Postgres.js connection against its test database. Assert complete relevant rows
and effects: nulls, JSON contents, precision, ordering, empty results, ownership, and rollback.
Include absent relationships, pagination ties, and empty aggregates where relevant. Keep those
tests alongside the query and run the application's normal TypeScript compiler.

Description can succeed for an invalid bound value, a write that violates a constraint, or an
operation the runtime role may not execute. Execution tests establish behavior for the exercised
inputs; they are not a proof for every possible input. Inspecting one variant does not cover
other branches or detect stale TypeScript annotations elsewhere in the application.

Describe does not bind runtime values. Cast standalone parameter projections, for example
`SELECT $1::boolean AS enabled`, so SQL establishes their types. Execution can otherwise infer a
type from a JavaScript value that an inspection without values cannot establish.
