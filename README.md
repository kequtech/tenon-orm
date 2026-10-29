# Tenon ORM

A PostgreSQL ORM designed for coding agents. Built for Node.js and TypeScript.

Write SQL directly, bind values with a template tag, and reuse queries through ordinary functions.
Tenon provides transactions, affected-row guards, SQL migrations, generated database types, and
query inspection and optional source-aware checking. Execution, Describe, codecs, and database type
generation come from the required
`@kequtech/pgclear` peer dependency (0.2.0 or later 0.x), which applications can update independently.

```sh
npm install @kequtech/tenon-orm @kequtech/pgclear
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
`returns` for the driver's result object and metadata.

Command `rowCount` values are numbers. SQL `count(*)`, bigint/bigserial columns, and bigint array
elements read as exact strings. Bind int8 inputs as strings or with pgclear `param(text, builtin.int8)`;
plain JavaScript bigint parameters reject. See the [value mappings](docs/reference.md#generated-types-and-checking).

Joins, relationships, aggregates, and upserts use PostgreSQL SQL. Object-based writes can use
`sql.insertValues` and `sql.assignments` while keeping the surrounding statement explicit.
`db.native` exposes the underlying pgclear `Pool` for prepared statements, streams, COPY, and
other driver features; those calls bypass Tenon's query and transaction guards. Use pgclear's
`listen` for a dedicated notification connection.

`sql<Row>` declares an expected result type. `tenon check src/users.ts:23` checks a recoverable query
against that type and PostgreSQL Describe without executing the statement. Inconclusive types remain
unproven; unsupported SQL composition is reported as unchecked. `describeQuery` inspects finished SQL
without comparing a source annotation. Keep database tests for actual
rows and write effects. Validation, authorization, and retry policy belong to the application.
Existing migration runners can be retained; Tenon's migrations and type generation are optional.

## Documentation

Start with this README, then follow the [agent guide](docs/agent-guide.md) when working in an
existing project or the [human guide](docs/human-guide.md) for a first setup. Use the reference for
specific options and the focused guides when a task needs them. Read the docs shipped with the
installed Tenon version; unreleased repository changes may differ.

- **[Human guide](docs/human-guide.md)** — a table, queries, transactions, and generated types.
- **[Agent guide](docs/agent-guide.md)** — implementation contracts and upgrade workflow.
- **[Reference](docs/reference.md)** — API options, value mappings, CLI, and limitations.
- **[Adoption guide](docs/adoption-guide.md)** — replace an ORM and transfer migration ownership.
- **[Mutation cookbook](docs/mutations.md)** — defaults, patches, upserts, arrays, and batching.
- **[Query inspection](docs/query-inspection.md)** — Describe reports and database tests.
- **[Query checking](docs/query-checking.md)** — project/file/line checking, composition, and limitations.
- **[Changelog](CHANGELOG.md)** — versioned changes and upgrade instructions.

For common failures, see [troubleshooting](docs/reference.md#troubleshooting). To choose between
source checking, SQL inspection, and generated-file freshness, see
[validation tools](docs/reference.md#choosing-a-validation-tool).

These documents all ship with the npm package, including the changelog so an agent upgrading a
project can read the relevant release entries locally. Repository maintenance instructions are in
[CONTRIBUTING.md](https://github.com/kequtech/tenon-orm/blob/main/CONTRIBUTING.md).

[ISC licensed](LICENSE). Maintained by [Kequtech](https://github.com/kequtech).
