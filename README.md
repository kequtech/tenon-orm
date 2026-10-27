# Tenon ORM

A PostgreSQL ORM designed for coding agents. Built for Node.js and TypeScript.

Your coding agent already knows SQL. Tenon gives it a small API for parameterized queries,
transactions, migrations, query inspection, and generated database types. Queries
stay readable, reusable operations are ordinary functions, and humans can review exactly what will
run against the database.

Tenon takes the place of an ORM without hiding PostgreSQL behind a query builder. You or your agent
write the SQL; Tenon handles binding values and returning results. Your application controls the
connection configuration and validation. Tenon includes its pinned Postgres.js driver.

```sh
npm install @kequtech/tenon-orm
```

Requires Node.js 24+, PostgreSQL 16+, and ESM. TypeScript consumers need TypeScript 6+ and
Node development typings.

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
  // user is { id: number; email: string } | undefined
} finally {
  await db.close();
}
```

This standalone example assumes the table exists. In a server, reuse an instance per database and
close it at shutdown, not after each request. Use `returns: 'many'` for an array, `'one'` when a row
must exist, or omit the option for the driver's full result.

Tenon also provides:

- Transactions and affected-row limits that roll back rejected writes.
- SQL migration files and a CLI to apply, inspect, and roll back migrations.
- TypeScript row, insert, and update types generated from your database.
- SQL fragments for sharing query parts or assembling variable conditions.
- Query descriptions from PostgreSQL, including parameter/result types and session context.

Joins, relationships, aggregates, and upserts use ordinary PostgreSQL SQL. Tenon does not introduce
model classes or automatically load related records. Input validation, authorization, and database
performance remain application concerns. You can keep an existing migration runner; Tenon's
migrations and table type generation are independent conveniences.

## Here's what a coding agent says about it

> "The appeal is that I can read the query, see where the transaction starts and ends, and put
> reusable logic in a function. There isn't much framework machinery to learn. The tradeoff is that
> someone still has to write the SQL and check the result types. I'm happy to do that part. Please
> still review my SQL."
>
> — Codex, after working on Tenon. An interested party, to put it mildly.

## Object-based writes

For object-based writes, `sql.insertValues(rows)` preserves database defaults across heterogeneous
rows and `sql.assignments(patch)` omits undefined fields. Keep the surrounding SQL explicit. Both
support selected columns.
Use [generated input types](docs/reference.md#insert-and-update-inputs) to check those objects
against your schema.

## Checking query results

The type in `sql<{ id: number; email: string }>` describes what you expect back. TypeScript alone
cannot verify that your SQL actually selects those columns.

Use `describeQuery({ connection, query })` to inspect the finished SQL, including dynamic fragments,
or `npx tenon describe query.sql` for a SQL file. It reports PostgreSQL types, Postgres.js values,
session context, and unresolved findings without executing the statement. No checking packages or
compiler API are required. Keep database tests for actual values, nullability, authorization, and
write effects; descriptions do not verify `sql<Row>`. See [query inspection](docs/query-inspection.md).

## Documentation

- **[Changelog](CHANGELOG.md)** — release changes and upgrade notes.
- **[Human guide](docs/human-guide.md)** — learn the workflow through practical examples.
- **[Agent guide](docs/agent-guide.md)** — self-contained setup, API contracts, and implementation
  conventions.
- **[Reference](docs/reference.md)** — complete options, query inspection, type mappings, and
  limitations.
- **[Adoption guide](docs/adoption-guide.md)** — replace an existing ORM and, if needed, transfer
  migration ownership, update local write helpers, and validate converted queries.
- **[Mutation cookbook](docs/mutations.md)** — defaults, patches, upserts, arrays, batching, and
  the boundaries between input typing and database validation.

The complete `docs/` folder ships with the npm package. Maintainer instructions are in
[CONTRIBUTING.md](https://github.com/kequtech/tenon-orm/blob/main/CONTRIBUTING.md), which is not
bundled.

[ISC licensed](LICENSE). Maintained by [Kequtech](https://github.com/kequtech).
