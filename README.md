# Tenon ORM

A PostgreSQL ORM for coding agents and the humans reviewing their work.

Tenon keeps SQL visible. It provides parameterized query templates, reusable
typed operations, migrations, and TypeScript row types generated from your
database. There are no model classes or query builders. “ORM” is doing a little
extra work in the name.

Dear agent: read the schema, bind your parameters, and run the tests. Your human
will be reading the diff.

Requires Node.js 24+, PostgreSQL 16+, ESM, and TypeScript 6+ for TypeScript consumers.

## Install

```sh
npm install @kequtech/tenon-orm pg
```

For TypeScript projects, also install the compiler and development typings:

```sh
npm install --save-dev typescript@^6 @types/node@^24 @types/pg
```

Set `"type": "module"` in the application's package.json. For a Node TypeScript
project, use `"module": "NodeNext"` and `"strict": true` in tsconfig.json.
Your application owns the pg driver and connection configuration. Tenon adds no
other runtime dependencies.

## Create the schema

```sh
npx tenon new create_users
```

Fill the generated migration files:

```sql
-- migrations/0001_create_users.up.sql
CREATE TABLE "User" (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);
```

```sql
-- migrations/0001_create_users.down.sql
DROP TABLE "User";
```

Set `DATABASE_URL` through your application's environment setup, then run:

```sh
npx tenon migrate
npx tenon generate --out src/generated-schema.ts
```

Commit the migrations and generated file. The CLI uses `DATABASE_URL`;
application code accepts any connection string, pg config, or existing pool.
For an existing database, start with [baseline adoption](docs/adopting.md).

## Write queries

```ts
import { createTenon, defineOperation, sql } from '@kequtech/tenon-orm';
import type { User } from './generated-schema.js';

type UserSummary = Pick<User, 'id' | 'email'>;

export const userByEmail = defineOperation(
  (email: string) => sql<UserSummary>`
    SELECT id, email FROM public."User" WHERE email = ${email}
  `,
  { returns: 'oneOrNone' },
);

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
const db = createTenon({ connection });

try {
  const user = await db.run(userByEmail, ['agent@example.test']);
  console.log(user?.email);

  const active = true;
  const users = await db.query(
    sql<UserSummary>`
    SELECT id, email FROM public."User" WHERE active = ${active} ORDER BY id
  `,
    { returns: 'many' },
  );
  console.log(users);
} finally {
  await db.close();
}
```

The `sql` tag turns interpolations into bound parameters. It never inserts a
string value into the SQL text. Export operations from ordinary modules and
import them where needed; input and result types travel with the definition.
`run` always takes an input array, including `[]` for a parameterless factory.

| `returns`          | Result                | Returned rows allowed |
| ------------------ | --------------------- | --------------------- |
| `native` (default) | pg `QueryResult<Row>` | Any                   |
| `many`             | `Row[]`               | Any, including zero   |
| `oneOrNone`        | `Row \| undefined`    | Zero or one           |
| `one`              | `Row`                 | Exactly one           |

A row type describes one record. Without one, fields are `unknown` and need
narrowing. TypeScript alone does not prove that a declared shape matches SQL.
The optional [SafeQL setup](docs/safeql.md) checks queries against your schema
during development and CI.

## Guard writes and group work

```ts
await db.transaction(async (tx) => {
  const id = 42;
  await tx.query(
    sql`
    UPDATE public."User" SET active = false WHERE id = ${id}
  `,
    { affectedRows: { exact: 1 } },
  );
});
```

`exact: 1` requires one affected row; `max: 1` permits zero or one. A mismatch
rolls back the statement before throwing. The option also works outside an
explicit transaction and on `defineOperation`.

The count covers the final command, excluding additional trigger, cascade, or
CTE effects. It cannot identify the wrong single row. Returned-row checks
(`returns`) alone do not undo autocommitted writes.

A transaction commits when its callback succeeds and rolls back when an error
escapes. Await all work and use `tx` inside it. Tenon does not retry callbacks.

## Working with Tenon

Read existing operations before adding another. Change schemas through new
migrations, regenerate row types, and run the application's SQL checks and
database tests. `tenon generate --check` detects stale generated output against
the connected database.

Tenon is a small SQL toolkit with an ORM's schema workflow. It provides no
automatic schema synchronization, relation loading, or runtime field validation.
Migrations are transactional; concurrent index creation needs a separate
maintenance procedure. Agent preference has not been measured.

These guides ship with the npm package:

- [API reference](docs/reference.md): execution, errors, types, and CLI.
- [SafeQL](docs/safeql.md): optional query checking and its limits.
- [Adoption](docs/adopting.md): bring an existing schema into migration history.
- [Design decisions](docs/design-decisions.md): rationale and remaining tradeoffs.
- [Contributing](docs/contributing.md) and [release preparation](docs/releasing.md).

[ISC licensed](LICENSE). Maintained by [Kequtech](https://github.com/kequtech).
