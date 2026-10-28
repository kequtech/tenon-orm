# Using Tenon: a human guide

Tenon lets you use PostgreSQL directly from TypeScript. You write SQL; Tenon binds its inputs and
executes it through Postgres.js. This guide follows a small application from its first table to reusable
queries, transactions, and result checking.

Use the [reference](reference.md) for exact contracts and [adoption](adoption-guide.md) when
replacing an existing ORM. Code blocks build on the connection and table introduced below;
query-function examples belong in their own module.

## Connect to your database

In an existing Node.js 24+ TypeScript project using ESM:

```sh
npm install @kequtech/tenon-orm
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

Reuse this instance across the application and call `await db.close()` at shutdown. You can also supply an existing Postgres.js client; your application then owns its shutdown.

## Create a table

If you already have a schema and migration runner, keep them. For a fresh example database,
create a migration:

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
`'many'` for an array, or omit `returns` for the native result array with `.count` and `.columns`.
These options do not change your SQL.

Generated table types can help describe projections without repeating every field:

```ts
import type { Rows } from './generated-schema.js';
type UserSummary = Pick<Rows['users'], 'id' | 'email'>;
```

You can then write `sql<UserSummary>`. A table type describes the full table; a join or aggregate
needs a type for what that particular query selects. An annotation is a declaration, not proof that
the SQL matches. Without one, result fields are `unknown`. Use the inspection and database-test
workflow below to check the declared contract against the query's behavior.

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

Use `Pick` to limit editable fields. Keep expressions, predicates, conflict handling, and
`RETURNING` in SQL. Selected columns choose fields; they do not validate the complete object.
See [input types](reference.md#insert-and-update-inputs) for mappings and the
[mutation cookbook](mutations.md) for defaults, batches, and upserts.

## Check your SQL and result types

Use `describeQuery({ connection, query })` on completed SQL, or `npx tenon describe query.sql` on a
file. It reports PostgreSQL metadata and a conservative `rowType` declaration; it does not update
or verify the application's `sql<Row>` annotation. Inspection uses a separate session, so match
the runtime role and settings. See [query inspection](query-inspection.md) for a worked test.

After migrating the development/test database, inspect meaningful query variants, run TypeScript,
and test actual rows and effects. Keep those checks in CI. Execution assertions cover values,
nulls, JSON, authorization, and rollback that description alone cannot establish.

## Reuse or assemble parts of SQL when needed

A fragment is a piece of SQL that carries its bound values with it. It is useful when multiple
queries share a condition. For example, a search can use the same predicate for its result page and
its count:

```ts
const pattern = '%example%';
const limit = 20;
const search = sql.fragment`active = ${true} AND email ILIKE ${pattern}`;
const page = sql<UserSummary>`SELECT id, email FROM public.users
  WHERE ${search} ORDER BY id LIMIT ${limit}`;
const count = sql<{ count: string }>`SELECT count(*) AS count FROM public.users
  WHERE ${search}`;
```

Execute each query with `db.query`. Validate application-supplied patterns and page sizes before
building queries. The complete query supplies the result type.

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
still applies. For an entirely optional set of filters, omit the whole `WHERE` clause when the list
is empty:

```ts
const optionalFilters = terms.map((term) => sql.fragment`email ILIKE ${'%' + term + '%'}`);
const unfilteredOrMatching = optionalFilters.length
  ? sql<UserSummary>`SELECT id, email FROM public.users WHERE ${sql.join(optionalFilters, 'AND')} ORDER BY id`
  : sql<UserSummary>`SELECT id, email FROM public.users ORDER BY id`;
```

`sql.join` and fragments require nonempty input. Keep mandatory authorization predicates in the
initial list when applicable; an empty optional-filter list must not remove them. Use parentheses
when mixing `AND` and `OR`. See the [composition reference](reference.md#sql-fragments-and-joins).

Use fixed SQL when composition is unnecessary. See the [reference](reference.md) for arrays,
identifiers, value mappings, CLI options, and error behavior.
