# Getting started

This guide creates a table, inserts and reads a user, reuses a query in a transaction, and generates
TypeScript types. You need an existing PostgreSQL database. If your application already has tables
and a migration runner, keep them and start at [Write and read a row](#write-and-read-a-row).

## Install and connect

Use Node.js 24+, PostgreSQL 16+, ESM, and TypeScript 6+ with Node.js development typings. In an
existing TypeScript project:

```sh
npm install @kequtech/tenon-orm
```

Keep the project's TypeScript configuration; a typical Node.js application uses `module: "NodeNext"`
and `strict: true`. Tenon includes its PostgreSQL driver, pgclear.

Supply `DATABASE_URL` through your environment setup. For a local example database:

```sh
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/your_database
```

Tenon does not create the database or load `.env` files. Create one shared database module:

```ts
// src/db.ts
import { createTenon } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
export const db = createTenon({ connection });
```

Reuse `db` across requests. Call `await db.close()` when a standalone script finishes or a server
shuts down. See [connections](connections.md) for pool options and application-owned pools.

## Create and apply a migration

In a fresh migrations directory:

```sh
npx tenon new create_users
```

This creates two empty files. Put the table definition in the up file:

```sql
-- migrations/0001_create_users.up.sql
CREATE TABLE public.users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);
```

Put the reverse operation in the down file:

```sql
-- migrations/0001_create_users.down.sql
DROP TABLE public.users;
```

Apply it to the database selected by `DATABASE_URL`:

```sh
npx tenon migrate
npx tenon status
```

For later changes, create a new migration. Applied files are checked against recorded checksums and
must stay unchanged. If a migration cannot be reversed, remove its down file before applying it.
See [migrations](migrations.md) for rollback and deployment behavior.

## Write and read a row

```ts
// src/example.ts
import { sql } from '@kequtech/tenon-orm';
import { db } from './db.js';

try {
  const email = 'reader@example.test';
  const created = await db.query(
    sql<{ id: number }>`INSERT INTO public.users (email) VALUES (${email}) RETURNING id`,
    { returns: 'one' },
  );

  const user = await db.query(
    sql<{ id: number; email: string; active: boolean }>`
      SELECT id, email, active FROM public.users WHERE id = ${created.id}
    `,
    { returns: 'oneOrNone' },
  );
  console.log(user);
} finally {
  await db.close();
}
```

This inserts a new email; rerunning it with the same email will fail the unique constraint. Run it
through your project's TypeScript runner or compile it with your application. The `.js` imports
follow NodeNext's convention for compiled TypeScript modules.

The template binds `${email}` separately from the SQL. Do not put quotes around an interpolation.
`sql<{ id: number }>` describes one returned row; `RETURNING id` asks PostgreSQL to return it.
`returns: 'one'` requires exactly one row, while `oneOrNone` permits absence as `undefined`.
Use `many` for an array or omit `returns` for the driver result with `.rows` and `.rowCount`.

The annotation does not check SQL or validate the row at runtime. Without an annotation, field values
are `unknown`. Bigint columns and SQL `count(*)` return strings by default; the integer ID in this
example returns a number. See [value mappings](schema-types.md#value-mappings) for JSON, arrays,
decimals, and dates.

## Reuse a query

Put reusable queries in ordinary functions. Accept `QueryClient` when a caller may supply either
`db` or a transaction's `tx`:

```ts
// src/queries.ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';

type UserSummary = { id: number; email: string };

export function userByEmail(client: QueryClient, { email }: { email: string }) {
  return client.query(sql<UserSummary>`SELECT id, email FROM public.users WHERE email = ${email}`, {
    returns: 'oneOrNone',
  });
}
```

Call `userByEmail(db, { email: 'reader@example.test' })`. Keep the SQL and result options together in
the function. Joins and aggregates work the same way; see [writing queries](sql.md).

## Use a transaction and a write guard

In code using the shared `db`:

```ts
import { sql } from '@kequtech/tenon-orm';
import { userByEmail } from './queries.js';

await db.transaction(async (tx) => {
  const user = await userByEmail(tx, { email: 'reader@example.test' });
  if (!user) throw new Error('User not found');

  await tx.query(sql`UPDATE public.users SET active = false WHERE id = ${user.id}`, {
    affectedRows: { exact: 1 },
  });
});
```

Run all participating queries through `tx` and await them. The callback commits on success and rolls
back when an error escapes.

The guard requires exactly one affected row and rolls back the update if the count differs. Use
`{ max: 1 }` to allow zero or one. Guards also work with `db.query` outside a callback. Result modes
such as `one` check returned rows; by themselves they do not undo an autocommitted write.

You still author the `WHERE` clause and application authorization. The
[transaction reference](reference.md#transactions-guarded-writes-and-errors) covers caught errors,
savepoints, and retry limits. For object-based inserts and patches, see [writing data](mutations.md).

## Generate types

Generation is optional. It reads the migrated database and writes table read/insert/update types.
Run it through the configured instance so the types use the same value conversions as your queries:

```ts
// scripts/generate-types.ts
import { parseArgs } from 'node:util';
import { db } from '../src/db.ts';

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
try {
  await db.generateTypes({ out: 'src/generated-schema.d.ts', check: values.check });
} finally {
  await db.close();
}
```

This script runs directly on Node.js 24+ using its TypeScript support. For this execution path,
`src/db.ts` must be runnable without build-time transformations or extension rewriting. If your
project compiles scripts, use its normal runner and import conventions instead. To typecheck `.ts`
imports with `noEmit`, enable `allowImportingTsExtensions`; emitting projects can use
`rewriteRelativeImportExtensions`.

Add these scripts to your existing `package.json`:

```json
{
  "scripts": {
    "db:generate": "node scripts/generate-types.ts",
    "db:check-types": "npm run db:generate -- --check",
    "db:migrate": "tenon migrate && npm run db:generate"
  }
}
```

Run `npm run db:generate` now. The output exports a `Database` type:

```ts
import type { Database } from './generated-schema.js';

type UserRow = Database['users']['row'];
type UserSummary = Pick<UserRow, 'id' | 'email'>;
type UserInsert = Database['users']['insert'];
type UserUpdate = Database['users']['update'];
```

Use `UserSummary` with `sql<UserSummary>` or `UserInsert` to type an insert input. These types
follow table columns, defaults, nullability, and codec representations. They do not validate
application inputs. Keep aliases in handwritten files and leave generated output unchanged.
See [schema types](schema-types.md) for an output example and mapping details.

## Keep schema and code in step

During development, run `npm run db:migrate`, review the generated diff, and commit migrations and
generated declarations together. Exclude the generated file from automatic formatting.

In CI, migrate a dedicated test database and check committed output without rewriting it:

```sh
npx tenon migrate
npm run db:check-types
npx tsc --noEmit
```

Do not run the regenerating `db:migrate` script before the freshness check: it would replace the file
you meant to verify. Production runs migrations and deploys the already-built application.

Optionally run `npx tenon check src/queries.ts` against the migrated database to compare source query
types with PostgreSQL metadata. Keep database tests for rows, permissions, and rollback. See
[choosing a validation tool](reference.md#choosing-a-validation-tool) and
[troubleshooting](reference.md#troubleshooting) as needed.
