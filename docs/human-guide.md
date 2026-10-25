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

If you already have a schema and migration runner, you can keep them. For new schemas, prefer plural
`snake_case` table names and `snake_case` column names. Tenon preserves your schema's exact names.
Create a migration:

```sh
npx tenon new create_users
```

Fill the generated files:

```sql
-- migrations/0001_create_users.up.sql
CREATE TABLE public.users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);
```

```sql
-- migrations/0001_create_users.down.sql
DROP TABLE public.users;
```

For development, add a script to `package.json` that applies migrations and updates generated types:

```json
{
  "scripts": {
    "db:migrate": "tenon migrate && tenon generate --out src/generated-schema.d.ts"
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
await db.query(sql`INSERT INTO public.users (email) VALUES (${email})`);
const user = await db.query(
  sql<{ id: number; email: string }>`
    SELECT id, email FROM public.users WHERE email = ${email}
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
import type { Rows } from './generated-schema.js';
type UserSummary = Pick<Rows['users'], 'id' | 'email'>;
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
import type { Rows } from './generated-schema.js';

type UserSummary = Pick<Rows['users'], 'id' | 'email'>;

export function userByEmail(client: QueryClient, { email }: { email: string }) {
  return client.query(sql<UserSummary>`SELECT id, email FROM public.users WHERE email = ${email}`, {
    returns: 'oneOrNone',
  });
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

  await tx.query(sql`UPDATE public.users SET active = false WHERE id = ${user.id}`, {
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

## Write objects without building column lists by hand

Use `sql.insertValues(rowOrRows)` inside an authored `INSERT` and `sql.assignments(patch)` after
`SET`. Inserts use database defaults for missing/undefined fields; updates omit those fields.
Explicit `null` stays null. Empty batches and updates throw. Heterogeneous insert rows remain
aligned, with `DEFAULT` for missing cells.

```ts
import type { Rows } from './generated-schema.js';

const input: Rows.Insert['users'] = { email: 'another@example.test' };
await db.query(sql`INSERT INTO public.users ${sql.insertValues(input, ['email'])}`);

const patch: Pick<Rows.Update['users'], 'active'> = { active: false };
await db.query(sql`UPDATE public.users SET ${sql.assignments(patch, ['active'])}
  WHERE email = ${input.email}`);
```

Generated insert types distinguish required fields from defaults and nullable fields. Update types
make writable fields optional; use `Pick` to limit what an action may edit. See the
[input-type reference](reference.md#insert-and-update-inputs) for write-value mappings.

Keep expressions, authorization, conflict handling and `RETURNING` in SQL. Selected column lists
choose which fields to write; they do not validate the complete object. See the
[mutation cookbook](mutations.md) for batches and upserts.

## Check your SQL and result types

There are three different jobs here:

- Tenon executes queries and binds values.
- TypeScript checks the application code and the result types you declare.
- SafeQL checks the SQL against your database and verifies or generates those types.

SafeQL is optional development tooling run by ESLint. Tenon's adapter supports queries, constant
fragments, and mutation helpers; `tenon/check-composition` reports queries it cannot inspect.
Follow the one-time [SQL checking setup](reference.md#sql-checking-with-safeql).

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

The checker supports constant fragments and `sql.join` with inline arrays. Runtime-built lists and
fragment-returning functions remain outside static analysis. Keep result annotations and database
tests for those queries; when using the checker, suppress `tenon/check-composition` only on the
tested query with a reason. Runtime-built mutation inputs need inline selected columns for SQL
checking. See the [checking reference](reference.md#supported-sql-and-limitations) for details.

## Reuse or assemble parts of SQL when needed

For fixed conditions, write them directly:

```ts
const users = await db.query(
  sql<UserSummary>`SELECT id, email FROM public.users WHERE active = ${true}`,
  { returns: 'many' },
);
```

A fragment is a piece of SQL that carries its bound values with it. It is useful when multiple
queries share a condition. For example, a search can use the same predicate for its result page and
its count:

```ts
const search = sql.fragment`active = ${true} AND email ILIKE ${pattern}`;
const page = sql<UserSummary>`SELECT id, email FROM public.users
  WHERE ${search} ORDER BY id LIMIT ${limit}`;
const count = sql<{ count: string }>`SELECT count(*) AS count FROM public.users
  WHERE ${search}`;
```

Here `pattern` is an application-supplied search pattern and `limit` is a validated page size.
Execute each query with `db.query`. The complete query supplies the result type.

Use `sql.join` when the number of fragments varies, such as one search condition per word or a set
of optional filters. It combines fragments with `'AND'`, `'OR'`, or `','` and preserves their bound
values:

```ts
const terms = ['reader', 'example'];
const filters = [sql.fragment`active = ${true}`];
for (const term of terms) {
  filters.push(sql.fragment`email ILIKE ${'%' + term + '%'}`);
}

const query = sql<UserSummary>`SELECT id, email FROM public.users
  WHERE ${sql.join(filters, 'AND')} ORDER BY id`;
```

This matches active users whose email contains every term. With no terms, the active condition
still applies. The list must be nonempty; `join` inserts separators, so use parentheses as usual
when mixing `AND` and `OR`. See the [composition reference](reference.md#sql-fragments-and-joins).

For arrays, identifiers, type mappings, CLI options, and error behavior, use the
[reference](reference.md). You do not need fragments or a query builder to use PostgreSQL joins,
aggregates, upserts, or other SQL features.
