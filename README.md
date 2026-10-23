# Tenon ORM

A PostgreSQL ORM built around SQL, with typed queries, migrations, and generated
TypeScript types. Designed for coding agents and the developers working with them.

Write PostgreSQL queries directly. Tenon binds input values, lets you choose how
results are returned, and provides transactions and optional affected-row checks.
Reusable queries are ordinary functions. Your application controls the `pg` driver,
connection configuration, and validation.

```sh
npm install @kequtech/tenon-orm pg
```

Requires Node.js 24+, PostgreSQL 16+, and ESM. TypeScript consumers need TypeScript 6+
and development typings for Node and `pg`.

```ts
import { createTenon, sql } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
const db = createTenon({ connection });

const email = 'reader@example.test';
const user = await db.query(
  sql<{ id: number; email: string }>`
    SELECT id, email FROM public."User" WHERE email = ${email}
  `,
  { returns: 'oneOrNone' },
);
// user is { id: number; email: string } | undefined

await db.close();
```

The example assumes the table exists. Reuse a database instance for each database connection and close owned pools at shutdown. Use `returns: 'many'` for an array, `'one'` when a row must
exist, or omit the option for the driver's full result.

Tenon also provides:

- Transactions and affected-row limits that roll back rejected writes.
- SQL migration files and a CLI to apply, inspect, and roll back migrations.
- TypeScript table row types generated from your database.
- SQL fragments for sharing query parts or assembling variable conditions.

Joins, relationships, aggregates, and upserts use ordinary PostgreSQL SQL. Tenon
does not introduce model classes or automatically load related records.

## Checking query results

The type in `sql<{ id: number; email: string }>` describes what you expect back.
TypeScript alone cannot verify that your SQL actually selects those columns.

For that, Tenon provides an optional integration with [SafeQL](https://safeql.dev/).
SafeQL checks SQL against your development database and can write or repair the
result annotation. ESLint runs the check during development and CI; it is not part
of query execution.

Tenon's `tenonSafeql` export configures SafeQL with a Tenon-specific adapter. The
adapter recognizes Tenon queries, resolves constant fragments, and preserves their
runtime parameter behavior; SafeQL performs the database analysis and annotation
fixes. The configuration also supplies type mappings for `pg`. Add it to your
application's existing ESLint setup. See [SQL checking setup](docs/reference.md#sql-checking-with-safeql)
for installation and configuration.

Checking complements typed inputs and database tests. It does not validate request
values or arbitrary JSON, and runtime-built query variants need their own tests.

## Documentation

- **[Human guide](docs/human-guide.md)** — learn the workflow through practical examples.
- **[Agent guide](docs/agent-guide.md)** — self-contained setup, API contracts, and implementation conventions.
- **[Reference](docs/reference.md)** — complete options, SQL checking setup, type mappings, and limitations.
- **[Adoption guide](docs/adoption-guide.md)** — replace an existing ORM and, if needed, transfer migration ownership.

The complete `docs/` folder ships with the npm package. Maintainer instructions are
in [CONTRIBUTING.md](https://github.com/kequtech/tenon-orm/blob/main/CONTRIBUTING.md),
which is not bundled.

[ISC licensed](LICENSE). Maintained by [Kequtech](https://github.com/kequtech).
