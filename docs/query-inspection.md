# Inspecting and testing queries

`describeQuery` asks PostgreSQL for a finished statement's parameter and result metadata. It does
not bind values or execute the statement. Use it to inspect SQL and to support database tests. To
compare TypeScript source annotations instead, use [query checking](query-checking.md).

## Inspect completed SQL

```ts
// scripts/inspect-query.ts
import { describeQuery, sql } from '@kequtech/tenon-orm';
import config from '../tenon.config.ts';

const connection = config.connection;

const query = sql<{ id: number; total: string }>`
  SELECT ${42}::integer AS id, count(*) AS total FROM pg_catalog.pg_class
`;
const description = await describeQuery({ connection, query });
```

Pass the same completed query to inspection and execution. `query` accepts SQL text or an object
with `text`, including a Tenon `SqlQuery`. Raw SQL uses `$1` placeholders; templates use `${value}`.
Inspection checks neither `query.values` nor its `sql<Row>` annotation.

Cast standalone parameters so PostgreSQL can infer their types without values. Alternatively pass
`query: { text, parameterTypes: [oid, ...] }` for explicit Describe hints. PostgreSQL still parses
and analyzes the statement, which can take locks.

## Session and timeouts

Inspection opens and closes its own short-lived session. `connection` accepts a PostgreSQL URI or pgclear pool-option values;
it does not reuse a runtime pool or transaction:

```ts
const description = await describeQuery({
  connection,
  query,
  session: { searchPath: 'app,public', timeZone: 'UTC' },
  timeouts: { connectMs: 3000, statementMs: 5000, lockMs: 1000 },
});
```

Match runtime settings. Optional `session.role` uses SET ROLE when permitted; it does not load that
role's login defaults. Omitted settings use the inspection connection's defaults. Explicit undefined
behaves like omission. Unknown keys and invalid settings reject.

`context` reports login/effective roles, configured/resolved search paths, timezone, database, and
effective statement/lock timeouts. Mode is `separate-session`, read mapping profile `pgclear`.
Temporary tables, uncommitted changes, and transaction-local state are not inherited. PG environment
variables, pgpass, service files, and `.env` are not loaded.

| Timeout       | Default  | Scope                         |
| ------------- | -------- | ----------------------------- |
| `connectMs`   | 3,000 ms | Connection and authentication |
| `statementMs` | 5,000 ms | Each server statement         |
| `lockMs`      | 1,000 ms | Lock wait                     |

Overrides are positive integer milliseconds up to 2,147,483,647. These are operation bounds, not a
single overall deadline. URI settings cannot disable statement/lock bounds. pg-specific
`query_timeout` and `options` URI parameters are unsupported; use the options above.

## Read the report

| Field                   | Meaning                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `parameters`            | OIDs, qualified PostgreSQL names, and read representations; these are not input contracts |
| `columns`               | Ordered names, PostgreSQL types, read representations, and available source metadata      |
| `columns[].nullability` | Always `"unknown"`; source `notNull` is informational                                     |
| `rowType`               | Conservative `DescribedRow` declaration, or null for no columns/duplicate names           |
| `issues`                | Findings with stable `code` and descriptive messages                                      |
| `context`               | Effective inspection-session settings                                                     |

Known read types in `rowType` include null; unknown already includes it. A source column's NOT NULL
constraint cannot prove result nullability through outer joins, expressions, or grouping. JSON
members remain unknown.

| Finding code          | Meaning                                               |
| --------------------- | ----------------------------------------------------- |
| `nullability-unknown` | Result nullability is unresolved                      |
| `shape-unknown`       | Listed columns have unknown shapes/read types         |
| `unmapped-type`       | A custom decoder has no known representation          |
| `duplicate-column`    | Repeated result names would fail object-row execution |

## Custom codecs

Programmatic inspection inherits `connection.codecs` when connection-option values are supplied.
With a URI, pass the runtime registry as `codecs`; omission uses defaults:

```ts
import { builtin, defaultCodecs } from '@kequtech/tenon-orm';

const codecs = defaultCodecs.with(builtin.jsonbText);
const description = await describeQuery({ connection, query, codecs });
```

That registry reports JSONB output as string. Scalar overrides affect derived built-in arrays;
explicit array overrides win. Custom `text.typescript` expressions appear in the conservative row
declaration and are shared with generation/source checking. Without known metadata, a custom
decoder remains unknown even for a familiar scalar/enum/domain OID. Catalog base types do not
replace the wire OID's decoder contract.

Inspection's own catalog/context queries use default decoding. Reported parameter read types are
not encoding rules: exact text can be a valid int8 input while its output also uses text by default.
See [schema mappings and codecs](schema-types.md#custom-codecs).

## Test the same statement

Use a dedicated test database. For `public.users` from [Getting started](human-guide.md), assume a
fixture contains `{ id: 1, email: 'ada@example.test', active: true }` and
`{ id: 2, email: 'lin@example.test', active: false }`. Here `db` and `connection` select that database:

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

Describe establishes metadata; execution tests establish behavior. Describe may succeed even when
bound values are invalid, constraints would reject a write, or the role lacks execution permission.
Test actual rows, write effects, authorization, JSON validation, and rollback. Exercise meaningful
composition variants and keep unexpected findings visible. Do not test query behavior by matching
words in documentation or SQL strings.

## CLI

Save raw SQL in `query.sql`:

```sql
SELECT $1::integer AS id, count(*) AS total FROM pg_catalog.pg_class;
```

```sh
npx tenon describe query.sql
npx tenon describe query.sql --search-path app,public --time-zone UTC
```

The CLI requires [shared configuration](configuration.md) and prints JSON using its connection
and codec registry. Pass `--config path` to select a specific module. Session flags are `--role`,
`--search-path`, and `--time-zone`; timeout flags are `--connect-timeout-ms`,
`--statement-timeout-ms`, and `--lock-timeout-ms`. Unsupported flags, including `--namespace` and
`--check`, reject.

Exit 0 means inspection succeeded, even with unresolved findings. Input, connection, timeout, or
PostgreSQL analysis failures exit 1. The inspected statement is never executed. Generated-file
freshness uses `tenon generate --check`, a separate operation.
