# Tenon ORM

A PostgreSQL ORM designed for coding agents. Built for Node.js and TypeScript.

Write SQL directly, bind values with a template tag, and reuse queries through ordinary functions.
Tenon provides transactions, affected-row guards, SQL migrations, generated database types, and
query inspection. It includes its pinned Postgres.js driver.

```sh
npm install @kequtech/tenon-orm
```

Requires Node.js 24+, PostgreSQL 16+, and ESM. TypeScript consumers need TypeScript 6+ and Node
development typings.

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

The example assumes `public.users` exists. In a server, reuse the instance and close it at shutdown.
`oneOrNone` rejects multiple rows; use `one` for exactly one row, `many` for an array, or omit
`returns` for the driver's result array and metadata.

Joins, relationships, aggregates, and upserts use PostgreSQL SQL. Object-based writes can use
`sql.insertValues` and `sql.assignments` while keeping the surrounding statement explicit.
`db.native` exposes the driver for LISTEN, cursors, COPY, and other native features; those calls
bypass Tenon's query and transaction guards.

`sql<Row>` declares an expected result type. `describeQuery` inspects the finished SQL through
PostgreSQL without executing it; it does not verify that annotation. Keep database tests for actual
rows and write effects. Validation, authorization, and retry policy belong to the application.
Existing migration runners can be retained; Tenon's migrations and type generation are optional.

## Documentation

- **[Human guide](docs/human-guide.md)** — a table, queries, transactions, and generated types.
- **[Agent guide](docs/agent-guide.md)** — implementation contracts and upgrade workflow.
- **[Reference](docs/reference.md)** — API options, value mappings, CLI, and limitations.
- **[Adoption guide](docs/adoption-guide.md)** — replace an ORM and transfer migration ownership.
- **[Mutation cookbook](docs/mutations.md)** — defaults, patches, upserts, arrays, and batching.
- **[Query inspection](docs/query-inspection.md)** — Describe reports and database tests.
- **[Changelog](CHANGELOG.md)** — versioned changes and upgrade instructions.

These documents all ship with the npm package, including the changelog so an agent upgrading a
project can read the relevant release entries locally. Repository maintenance instructions are in
[CONTRIBUTING.md](https://github.com/kequtech/tenon-orm/blob/main/CONTRIBUTING.md).

[ISC licensed](LICENSE). Maintained by [Kequtech](https://github.com/kequtech).
