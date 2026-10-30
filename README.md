# Tenon ORM

A PostgreSQL ORM designed for coding agents. Built for Node.js and TypeScript.

Tenon keeps database work in forms coding agents can read, write, and check: explicit SQL, ordinary
TypeScript functions, and SQL migrations. Queries carry their result types and execution options
together, so an agent and the person reviewing its work can see what an operation does in one place.

```sh
npm install @kequtech/tenon-orm
```

Requires Node.js 24+, PostgreSQL 16+, and ESM. TypeScript applications need TypeScript 6+ and Node.js
typings. The PostgreSQL driver, [pgclear](https://github.com/kequtech/pgclear), is included.

## Query with SQL

This example assumes a `public.users` table with integer `id` and text `email` columns:

```ts
import { createTenon, sql } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
const db = createTenon({ connection });

try {
  const email = 'reader@example.test';
  const user = await db.query(
    sql<{ id: number; email: string }>`
      SELECT id, email FROM public.users WHERE email = ${email}
    `,
    { returns: 'oneOrNone' },
  );
  // user: { id: number; email: string } | undefined
} finally {
  await db.close();
}
```

`${email}` becomes `$1` in the SQL, with the value passed separately. `sql<Row>` describes one
returned row. `returns` chooses how Tenon gives those rows back:

| `returns`          | You receive                                         | Required rows |
| ------------------ | --------------------------------------------------- | ------------- |
| `many`             | `readonly Row[]`                                    | Any number    |
| `oneOrNone`        | `Row \| undefined`                                  | Zero or one   |
| `one`              | `Row`                                               | Exactly one   |
| `native` (default) | Driver result with `rows`, `rowCount`, and `fields` | Any number    |

A row-count mismatch throws. The modes do not add `LIMIT` or change the SQL. In a server, reuse one
database instance and close it during shutdown. Supply environment variables through your application;
Tenon does not load `.env` files.

## Designed for coding agents

Tenon's API gives coding agents concrete code to work with and explicit contracts to preserve:

- **Readable SQL.** Selected columns, joins, filters, and conflict handling are visible in the query.
  An agent can inspect the operation directly and use PostgreSQL's existing vocabulary.
- **Ordinary TypeScript.** Reusable queries are functions. An agent can follow imports, change a
  function, and pass the same query code a database or transaction client.
- **Explicit write limits.** A query can require exactly one affected row or set a maximum. Tenon
  rolls back the operation if that bound is violated.
- **Actionable checks.** Generated table types describe storage contracts; `tenon check` reports
  contradictions between recoverable SQL and declared types. Freshness checks catch stale generated
  declarations, and database tests verify results and effects.

The guides and changelog ship with the package, giving an agent documentation for the installed
version. For work in an existing project, start with the [agent guide](docs/agent-guide.md).

## How Tenon fits together

- **SQL defines the operation.** Use PostgreSQL joins, aggregates, constraints, and upserts directly.
  Reuse queries with ordinary functions; use fragments when parts of the SQL need to vary.
- **TypeScript describes the values.** Declare query projections with `sql<Row>`. Optionally generate
  table read/insert/update types with `tenon generate`.
- **Transactions define what commits together.** Use `db.transaction(async (tx) => { ... })` and run
  every participating query through `tx`.
- **Write guards check affected rows.** `{ affectedRows: { exact: 1 } }` rolls back a write unless
  exactly one row was affected. `{ max: 1 }` allows zero or one.
- **Migrations change the schema.** Tenon's optional runner applies numbered SQL files. You can keep
  an existing schema and migration runner.

For object inputs, `sql.insertValues(input)` and `sql.assignments(patch)` build the column/value
parts of a statement. The table, conditions, expressions, and conflict behavior stay in your SQL.
There are no model instances or implicit relationship loading.

Query types are declarations. Tenon does not validate returned data against `Row` during execution.
The optional `tenon check` command compares recoverable source queries with TypeScript types and
PostgreSQL metadata. Keep database tests for actual results and write effects.

Some PostgreSQL values need care: bigint columns and `count(*)` read as exact strings, numeric and
temporal values also default to strings, and JSON/array inputs use explicit encoding helpers. Command
`rowCount` is a number or null. See [value mappings](docs/schema-types.md#value-mappings) before
choosing application types.

## Share configuration with the CLI

Run `tenon init` to create `tenon.config.ts`, put connection settings and codecs there, and use its
`connection` in `createTenon`.
Then run `tenon generate`, `tenon generate --check`, `tenon check`, and `tenon describe query.sql`
without custom scripts. Migration commands also use the shared connection and migration defaults.
See [shared configuration](docs/configuration.md) for the complete setup.

## Documentation

Start with [Getting started](docs/human-guide.md) for a complete table-to-query example. Then choose
the guide for your task:

| Guide                                                      | What it covers                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Shared configuration](docs/configuration.md)              | Runtime/CLI connection settings, codecs, command defaults, and overrides     |
| [Writing queries](docs/sql.md)                             | Parameters, reusable functions, joins, aggregates, pagination, and fragments |
| [Writing data](docs/mutations.md)                          | Inserts, patches, defaults, upserts, JSON, arrays, and batches               |
| [Schema types and values](docs/schema-types.md)            | Generation, read/write types, codecs, and domain validation                  |
| [Migrations](docs/migrations.md)                           | Creating, applying, inspecting, and rolling back SQL migrations              |
| [Connections and driver access](docs/connections.md)       | Pool configuration, shutdown, custom codecs, and native features             |
| [Checking query types](docs/query-checking.md)             | Source-aware checks and their supported SQL composition                      |
| [Inspecting and testing queries](docs/query-inspection.md) | PostgreSQL metadata and tests of real behavior                               |
| [Adopting Tenon](docs/adoption-guide.md)                   | Replacing an ORM and transferring migration ownership                        |
| [Agent guide](docs/agent-guide.md)                         | A short implementation workflow for an existing project                      |
| [API and CLI reference](docs/reference.md)                 | Signatures, options, errors, commands, and troubleshooting                   |

The README, guides, and [changelog](CHANGELOG.md) ship with the npm package. Read the documentation
for your installed version when upgrading. Library maintenance is covered in
[CONTRIBUTING.md](https://github.com/kequtech/tenon-orm/blob/main/CONTRIBUTING.md).

[ISC licensed](LICENSE). Maintained by [Kequtech](https://github.com/kequtech).
