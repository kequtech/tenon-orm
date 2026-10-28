# Inspect and test queries

`describeQuery` asks PostgreSQL for a completed statement's parameter/result metadata without
binding its values or executing it. Inspection is included with Tenon and opens a separate,
short-lived connection. It works with SQL assembled from fragments and mutation helpers.

## Inspect completed SQL

```ts
import { describeQuery, sql } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');

const query = sql<{ id: number; total: string }>`
  SELECT ${42}::integer AS id, count(*) AS total FROM pg_catalog.pg_class
`;
const description = await describeQuery({ connection, query });
```

`query` accepts SQL text or an object with `text`, including `SqlQuery`. Pass the same completed
query to inspection and execution. Strings use PostgreSQL `$1` placeholders; templates use
`${value}`. Cast standalone parameters so PostgreSQL can infer their types without runtime values.
Inspection does not read `sql<Row>`, check `query.values`, or compare an annotation with SQL.

## Session and timeouts

```ts
const description = await describeQuery({
  connection,
  query,
  session: { searchPath: 'app,public', timeZone: 'UTC' },
  timeouts: { connectMs: 3000, statementMs: 5000, lockMs: 1000 },
});
```

Reuse the runtime URI and session settings. Optional `session.role` uses SET ROLE when permitted;
it does not load that role's login defaults. Omitted settings use the inspection connection's
defaults. Explicit undefined behaves like omission. Unknown keys and invalid settings fail.

`context` reports login/effective roles, configured/resolved search paths, timezone, database, and
effective statement/lock timeouts. Its mode is `separate-session` and read mapping profile is
`postgres`. Custom parsers, temporary tables, uncommitted changes, and transaction-local settings
are not inherited. `PGOPTIONS` is not automatically copied; use URI startup options or session
settings. Array mappings include Tenon's SQL NULL correction.

Defaults are a 3-second connection/authentication timeout, a 5-second limit per server statement,
and a 1-second lock wait. Overrides are positive integer milliseconds, at most 2,147,483,647.
URI settings cannot disable the statement/lock bounds. Cleanup uses a 1-second driver shutdown
timeout. These are operation limits, not a single overall deadline.

## Result fields

| Field                   | Meaning                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `parameters`            | OIDs, qualified PostgreSQL names, and read representations; not JavaScript input contracts |
| `columns`               | Ordered names, PostgreSQL types, read representations, and source metadata where available |
| `columns[].nullability` | Always `"unknown"`; source `notNull` is informational                                      |
| `rowType`               | Conservative `DescribedRow` declaration, or null for no columns/duplicate names            |
| `issues`                | Findings with stable `code` fields and descriptive messages                                |
| `context`               | Effective inspection-session settings                                                      |

Known read types in `rowType` include null; unknown types already include it. Source constraints
cannot establish result nullability through joins, expressions, or grouping. JSON structure stays
unknown. Handle findings by code:

| Code                  | Meaning                                                         |
| --------------------- | --------------------------------------------------------------- |
| `nullability-unknown` | Result nullability is unresolved                                |
| `shape-unknown`       | Listed output columns have unknown shapes/read types            |
| `unmapped-type`       | A parameter or result type has no verified driver mapping       |
| `duplicate-column`    | Repeated result names would overwrite earlier object properties |

## Test the same statement

For the `public.users` table from the [human guide](human-guide.md), assume a dedicated test fixture
has rows `{ id: 1, email: 'ada@example.test', active: true }` and
`{ id: 2, email: 'lin@example.test', active: false }`, and `db` is its runtime connection:

```ts
import assert from 'node:assert/strict';

function usersQuery(activeOnly: boolean) {
  const filters = [sql.fragment`email LIKE ${'%@example.test'}`];
  if (activeOnly) filters.push(sql.fragment`active = ${true}`);
  return sql<{ id: number; email: string }>`SELECT id, email FROM public.users
    WHERE ${sql.join(filters, 'AND')} ORDER BY id`;
}

const ada = { id: 1, email: 'ada@example.test' };
const lin = { id: 2, email: 'lin@example.test' };
for (const activeOnly of [false, true]) {
  const query = usersQuery(activeOnly);
  const description = await describeQuery({ connection, query });
  assert.deepEqual(
    description.columns.map(({ name, readType }) => [name, readType]),
    [
      ['id', 'number'],
      ['email', 'string'],
    ],
  );
  assert.deepEqual(
    description.issues.map(({ code }) => code),
    ['nullability-unknown'],
  );
  assert.deepEqual(await db.query(query, { returns: 'many' }), activeOnly ? [ada] : [ada, lin]);
}
```

Description and execution establish different facts. Describe can succeed for invalid bound values,
a write that violates constraints, or an operation the runtime role cannot execute. Check actual
rows/effects, JSON, permissions, and rollback in database tests, and run TypeScript. Inspect
meaningful query variants; one instance does not cover unexercised branches. Expect only reviewed
findings and keep unexpected ones visible.

A query builder is optional. When a test needs to retain executed statements, a test-only
`QueryClient` wrapper can forward them and retain `{ text }` without parameter values. Production
`onQuery` deliberately supplies neither SQL nor values.

## CLI

Save SQL with PostgreSQL placeholders in `query.sql`:

```sql
SELECT $1::integer AS id, count(*) AS total FROM pg_catalog.pg_class;
```

```sh
npx tenon describe query.sql
npx tenon describe query.sql --search-path app,public --time-zone UTC
```

The CLI uses `DATABASE_URL` and prints JSON. Session flags are `--role`, `--search-path`, and
`--time-zone`. Timeout flags are `--connect-timeout-ms`, `--statement-timeout-ms`, and
`--lock-timeout-ms`. Migration/generation flags such as `--namespace` and `--check` are rejected.

Exit 0 means description succeeded, including reports with unresolved findings. Exit 1 means input,
connection, timeout, or PostgreSQL analysis failed. The inspected statement is never executed.
