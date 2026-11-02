# Tenon ORM

A PostgreSQL ORM designed for coding agents and the people reading their work.
Explicit SQL, typed query results, guarded writes and application-owned SQL migrations. Node.js 24+, PostgreSQL 16+, TypeScript
6+, ESM.

```sh
npm install @kequtech/tenon-orm
```

```ts
import { createTenon, sql } from '@kequtech/tenon-orm';

type User = { id: number; email: string };

const db = createTenon({ connection: process.env.DATABASE_URL });
try {
  const user = await db.query(sql<User>`SELECT id, email FROM users WHERE id = ${1}`, {
    returns: 'oneOrNone',
  });
  console.log(user?.email);
} finally {
  await db.close();
}
```

This example assumes a `users` table with integer `id` and text `email` columns.
Interpolations bind values separately from SQL; PostgreSQL infers parameter types from context.
`sql<Row>` describes one result row; `returns`
chooses `many`, `oneOrNone`, `one`, or the default driver result. Tenon adds no implicit limits,
relationship loading, transaction retries or runtime validation of `Row`.

Reuse queries as ordinary functions accepting `QueryClient`, so callers can pass a database or a
transaction. Keep the SQL, result type and execution options together. Use affected-row guards when
writes must change exactly one row or stay below a bound. The optional checker compares recoverable
source queries with PostgreSQL metadata; database tests establish actual behavior.

The [pgclear driver](https://github.com/kequtech/pgclear) and
[Jobs engine](https://github.com/kequtech/pgclear-jobs) are included. Jobs supports transactional
submissions and durable background work; installing storage and starting workers are explicit.
The TypeScript compiler is installed for checking and loaded only when checking.
A server reuses one database instance and closes it after its requests and workers stop.

| Task                                                         | Guide                                      |
| ------------------------------------------------------------ | ------------------------------------------ |
| First setup or a change in an existing application           | [Getting started](docs/getting-started.md) |
| Read, write, compose SQL and use transactions                | [Queries](docs/queries.md)                 |
| Configure connections, host the database and migrate schemas | [Database](docs/database.md)               |
| Generate types and choose value representations              | [Types and values](docs/types.md)          |
| Check source SQL, inspect queries and compare schemas        | [Checking](docs/checking.md)               |
| Produce and run reliable background work                     | [Jobs](docs/jobs.md)                       |
| Look up signatures, defaults, errors and commands            | [Reference](docs/reference.md)             |

Tenon documents the application-facing workflow. The included libraries own their detailed
[driver contracts](https://github.com/kequtech/pgclear/blob/17fae30540cbc41ce2c776645437c6d265e2de96/README.md) and
[queue contracts](https://github.com/kequtech/pgclear-jobs/blob/521a1370abd9f3c7cf4baeaef68737cf2cabbee4/README.md); both also work standalone.

The guides and [changelog](CHANGELOG.md) ship with the package. `npx tenon docs` prints the exact
installed versions and local guide paths for all three packages; `--json` makes those paths scriptable.
Resolution follows Tenon's dependencies, including isolated pnpm layouts. Read those files for the
contracts your application actually uses. Cross-package contract links use reviewed source revisions.
Maintainer instructions are in
[CONTRIBUTING.md](https://github.com/kequtech/tenon-orm/blob/main/CONTRIBUTING.md).

[ISC licensed](LICENSE). Maintained by [Kequtech](https://github.com/kequtech).
