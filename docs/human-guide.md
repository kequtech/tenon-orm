# Using Tenon: a human guide

Tenon lets you use PostgreSQL directly from TypeScript. You write SQL; Tenon binds its inputs and
executes it through `pg`. This guide follows a small application from its first table to reusable
queries, transactions, and result checking.

Use the [reference](reference.md) when you need exact options or unusual cases. The
[agent guide](agent-guide.md) is a separate working guide for coding agents;
[adoption](adoption-guide.md) covers moving an existing application to Tenon.

## Connect to your database

In an existing Node.js 24+ TypeScript project using ESM:

```sh
npm install @kequtech/tenon-orm pg
npm install --save-dev @types/pg
```

Use PostgreSQL 16+ and TypeScript 6+. Keep your existing strict TypeScript configuration and Node
typings. Supply `DATABASE_URL` through your application's environment setup; Tenon does not load
`.env` files.

```ts
// src/db.ts
import { createTenon } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
export const db = createTenon({ connection });
```

Reuse this instance across the application and call `await db.close()` at shutdown. For multiple
databases, create an instance for each connection. You can also supply an existing `pg.Pool`; your
application then closes that pool.

## Create a table

If you already have a schema and migration runner, you can keep them. For a new schema, create a
migration:

```sh
npx tenon new create_users
```

Fill the generated files:

```sql
-- migrations/0001_create_users.up.sql
CREATE TABLE public."User" (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);
```

```sql
-- migrations/0001_create_users.down.sql
DROP TABLE public."User";
```

For development, add a script to `package.json` that applies migrations and updates table row types:

```json
{
  "scripts": {
    "db:migrate": "tenon migrate && tenon generate --out src/generated-schema.ts"
  }
}
```

```sh
npm run db:migrate
```

Commit migrations and generated types together. In production, run only `npx tenon migrate`; deploy
the already-built application. If you do not use generated table types, omit generation from the
development script. For later schema changes, add a new migration instead of editing an applied one.
If a change cannot be reversed, omit its down file. A down migration is not a backup.

## Write a query

Create a row, then read the fields you need:

```ts
import { sql } from '@kequtech/tenon-orm';
import { db } from './db.js';

const email = 'reader@example.test';
await db.query(sql`INSERT INTO public."User" (email) VALUES (${email})`);
const user = await db.query(
  sql<{ id: number; email: string }>`
    SELECT id, email FROM public."User" WHERE email = ${email}
  `,
  { returns: 'oneOrNone' },
);
```

`${email}` becomes a bound parameter. Do not put quotes around it: the driver passes the value
separately from the SQL text, even when the value contains SQL.

The type describes one selected row. `returns: 'oneOrNone'` gives you that row or `undefined`; it
throws if the query returns more than one row. Use `'one'` when absence should also be an error,
`'many'` for an array, or omit `returns` for the full driver result with `.rows` and `.rowCount`.
These options do not change your SQL.

Generated table types can help describe projections without repeating every field:

```ts
import type { User } from './generated-schema.js';
type UserSummary = Pick<User, 'id' | 'email'>;
```

You can then write `sql<UserSummary>`. A table type describes the full table; a join or aggregate
needs a type for what that particular query selects. An annotation is a declaration, not proof that
the SQL matches. Without one, result fields are `unknown`. The checking workflow below can generate
and verify it.

## Reuse a query with a function

Use an ordinary function when several callers need the same query. An object input makes the
supplied values easy to read:

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';
import type { User } from './generated-schema.js';

type UserSummary = Pick<User, 'id' | 'email'>;

export function userByEmail(client: QueryClient, { email }: { email: string }) {
  return client.query(
    sql<UserSummary>`SELECT id, email FROM public."User" WHERE email = ${email}`,
    { returns: 'oneOrNone' },
  );
}

const user = await userByEmail(db, { email: 'reader@example.test' });
```

`QueryClient` means the function accepts either your database instance or a transaction client. Keep
the SQL and execution options together in the function.

## Change data in a transaction

```ts
await db.transaction(async (tx) => {
  const user = await userByEmail(tx, { email: 'reader@example.test' });
  if (!user) throw new Error('User not found');

  await tx.query(sql`UPDATE public."User" SET active = false WHERE id = ${user.id}`, {
    affectedRows: { exact: 1 },
  });
});
```

Use `tx` for all work in the callback and await it. Tenon commits when the callback succeeds and
rolls back when an error escapes.

`affectedRows: { exact: 1 }` requires exactly one affected row. `{ max: 1 }` permits zero or one.
Tenon rolls back a write that violates the bound. You can also use these guards on `db.query`
outside a callback transaction. The guard checks a count; you still need the correct `WHERE` clause
and application authorization. Checking returned rows with `returns` alone does not undo an
autocommitted write.

## Check your SQL and result types

There are three different jobs here:

- Tenon executes queries and binds values.
- TypeScript checks the application code and the result types you declare.
- SafeQL checks the SQL against your database and verifies or generates those types.

SafeQL is optional development tooling run by ESLint. Configure it normally, with Tenon's
`safeqlPlugin` adapter to translate queries and constant fragments. A small companion ESLint rule,
`tenon/check-composition`, flags queries that cannot be checked statically. SafeQL performs the
database analysis and annotation fixes. Your application's ESLint configuration imports these tools;
Tenon's database runtime does not need them. Generated table types are a separate convenience and
are not required by SafeQL. Follow the one-time
[SQL checking setup](reference.md#sql-checking-with-safeql).

Use the application's existing lint commands. If it has none, the setup shows `lint` and `lint:fix`.
They run ESLint, including all other enabled rules. Once configured, the normal workflow is:

1. Run `npm run db:migrate` against the development/test database.
2. Run `npm run lint` to find SQL errors and missing or incorrect annotations.
3. Use `npm run lint:fix` to generate or repair annotations, then review the diff.
4. Run TypeScript and database tests. CI runs the check without fixing files.

For example, SafeQL can turn `sql` followed by a query selecting `id, email` into
`sql<{ id: number; email: string }>` based on your actual schema. It can detect a renamed column or
an incorrect declared result type before the query runs.

Input validation and database tests still matter. Checking a query does not prove that a request is
authorized, that its values are valid, or that returned JSON has an application-specific shape.

## Reuse or assemble parts of SQL when needed

For fixed conditions, write them directly:

```ts
const users = await db.query(
  sql<UserSummary>`SELECT id, email FROM public."User" WHERE active = ${true}`,
  { returns: 'many' },
);
```

A fragment is a piece of SQL that carries its bound values with it. It is useful when multiple
queries share a condition. For example, a search can use the same predicate for its result page and
its count:

```ts
const search = sql.fragment`active = ${true} AND email ILIKE ${pattern}`;
const page = sql<UserSummary>`SELECT id, email FROM public."User"
  WHERE ${search} ORDER BY id LIMIT ${limit}`;
const count = sql<{ count: string }>`SELECT count(*) AS count FROM public."User"
  WHERE ${search}`;
```

Here `pattern` is an application-supplied search pattern and `limit` is a validated page size.
Execute each query with `db.query`. A fragment cannot execute alone; the complete query supplies the
result type. The checker can inspect these constant fragments.

For a simple optional filter, a fixed SQL predicate often suffices:

```ts
// email is string | null; null means no email filter.
const query = sql<UserSummary>`SELECT id, email FROM public."User"
  WHERE active = ${true} AND (${email}::text IS NULL OR email = ${email})`;
```

If you need a variable list of conditions, `sql.join` combines fragments using `'AND'`, `'OR'`, or
`','`. **SafeQL cannot check runtime-built lists.** Keep an explicit result type and test each
variant; if you use SafeQL, suppress only this query with an explanation. Parameter binding still
works, but it does not prove that every variant is valid SQL or returns the declared columns.

```ts
const filters = [sql.fragment`active = ${true}`];
if (email !== undefined) filters.push(sql.fragment`email = ${email}`);

// eslint-disable-next-line tenon/check-composition -- Runtime filters are covered by database tests.
const query = sql<UserSummary>`SELECT id, email FROM public."User"
  WHERE ${sql.join(filters, 'AND')} ORDER BY id`;
```

The initial condition keeps this list nonempty. Empty lists throw so that missing filters cannot
silently remove a condition. `join` adds separators, not parentheses; wrap groups explicitly when
mixing `AND` and `OR`. Full queries cannot be used as fragments. See the
[composition reference](reference.md#sql-fragments-and-joins) for static checking rules and other
details.

For arrays, identifiers, type mappings, CLI options, and error behavior, use the
[reference](reference.md). You do not need fragments or a query builder to use PostgreSQL joins,
aggregates, upserts, or other SQL features.
