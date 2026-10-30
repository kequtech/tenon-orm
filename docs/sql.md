# Writing queries

Tenon executes PostgreSQL SQL. A query has SQL text, separately bound values, and an optional
TypeScript type for one returned row. Examples use the `public.users` table from
[Getting started](human-guide.md) and an existing `db` instance.

## Bind values

```ts
import { sql } from '@kequtech/tenon-orm';

const email = 'reader@example.test';
const query = sql<{ id: number; email: string }>`
  SELECT id, email FROM public.users WHERE email = ${email}
`;
// query.text: SQL containing WHERE email = $1
// query.values: ['reader@example.test']
const user = await db.query(query, { returns: 'oneOrNone' });
```

Constructing `query` does not contact PostgreSQL. Execute it with `db.query` or `tx.query`. Do not
quote interpolations or write `$1` placeholders inside templates.

Plain inputs accept null, strings, finite numbers, bigint, booleans, valid Date values, supported
Temporal values, and Uint8Array. Arrays and objects need explicit encoders; undefined is not a bound
SQL value. See [JSON and arrays](mutations.md#json-and-postgresql-arrays). Bound data must remain
unchanged until the query settles.

## Choose the result you need

Use `one` for exactly one row, `oneOrNone` for zero or one, and `many` for an array. The default
`native` result provides rows and command metadata:

```ts
const result = await db.query(sql`UPDATE public.users SET active = false WHERE id = ${42}`);
console.log(result.command, result.rowCount); // UPDATE, number of affected rows
```

The modes check rows actually returned. An `UPDATE` without `RETURNING` returns no rows even when
it changes data. Modes do not add `RETURNING` or `LIMIT`. See the
[result reference](reference.md#queries-and-result-modes) for exact types.

Reuse queries with functions that accept `QueryClient`, so the same function can receive `db` or
`tx`. The [getting-started example](human-guide.md#reuse-a-query) shows this pattern.

## Join related tables

Add this example table in a migration:

```sql
CREATE TABLE public.posts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  title text NOT NULL
);
```

Select and alias the columns you want. There is no relationship configuration or automatic loading:

```ts
type PostWithAuthor = { id: number; title: string; authorEmail: string };

const posts = await db.query(
  sql<PostWithAuthor>`
    SELECT p.id, p.title, u.email AS "authorEmail"
    FROM public.posts AS p
    JOIN public.users AS u ON u.id = p.user_id
    WHERE u.active = ${true}
    ORDER BY p.id
  `,
  { returns: 'many' },
);
```

Use unique column names; selecting both `p.id` and `u.id` without aliases produces duplicate names,
which the driver rejects. Quoted aliases preserve camelCase. An outer join can introduce null even
for a source column declared `NOT NULL`; reflect that in the query's result type:

```ts
type UserWithPost = { userId: number; title: string | null };
const rows = await db.query(
  sql<UserWithPost>`
    SELECT u.id AS "userId", p.title
    FROM public.users AS u
    LEFT JOIN public.posts AS p ON p.user_id = u.id
    ORDER BY u.id, p.id
  `,
  { returns: 'many' },
);
```

A user with several posts appears several times. Group rows in application code or use PostgreSQL
aggregation when a nested result is needed. JSON aggregate output is `unknown` by default; validate
it before narrowing to an application type.

## Aggregate values

```ts
const totals = await db.query(
  sql<{ userId: number; total: string }>`
    SELECT u.id AS "userId", count(p.id) AS total
    FROM public.users AS u
    LEFT JOIN public.posts AS p ON p.user_id = u.id
    GROUP BY u.id
    ORDER BY u.id
  `,
  { returns: 'many' },
);
```

`count(p.id)` counts matched posts, including zero for a user without posts. `count(*)` would also
count that user's outer-join row. Both return PostgreSQL bigint, decoded as an exact string. Other
aggregate result types depend on PostgreSQL's selected function and input type; use
[inspection](query-inspection.md) when unsure.

## Paginate with an explicit order

For an integer ID cursor, validate `afterId` and `pageSize` in application code, then bind them:

```ts
async function usersAfter(afterId: number, pageSize: number) {
  if (!Number.isInteger(afterId) || afterId < 0) throw new Error('Invalid cursor');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('Page size must be between 1 and 100');
  }
  return db.query(
    sql<{ id: number; email: string }>`
      SELECT id, email FROM public.users
      WHERE id > ${afterId} ORDER BY id LIMIT ${pageSize}
    `,
    { returns: 'many' },
  );
}
```

Start with `afterId = 0`, then use the last returned ID for the next page. A unique ordering makes
page boundaries deterministic. For another sort column, include a unique tiebreaker and carry both
values in the cursor. Tenon does not add pagination or ordering.

## Compose SQL fragments

A fragment carries SQL and its bound values. It cannot execute alone and has no result type:

```ts
const pattern = '%example%';
const condition = sql.fragment`active = ${true} AND email ILIKE ${pattern}`;
const page = sql<{ id: number; email: string }>`
  SELECT id, email FROM public.users WHERE ${condition} ORDER BY id LIMIT ${20}
`;
const total = sql<{ total: string }>`SELECT count(*) AS total FROM public.users WHERE ${condition}`;
```

Use `sql.join` for a list of conditions. It supports `'AND'`, `'OR'`, and `','`, without adding
parentheses:

```ts
const terms = ['reader', 'example'];
const filters = [sql.fragment`active = ${true}`];
for (const term of terms) {
  filters.push(sql.fragment`email ILIKE ${'%' + term + '%'}`);
}
const query = sql<{ id: number }>`
  SELECT id FROM public.users WHERE ${sql.join(filters, 'AND')} ORDER BY id
`;
```

The initial condition keeps the list nonempty. If every condition is optional, choose a complete
query without `WHERE` when the list is empty. Retain required authorization conditions in every
branch. `sql.join([])` and blank fragments fail. Parenthesize groups when mixing `AND` and `OR`.
Parameters are numbered correctly across nested and repeated fragments.

Runtime loops and dynamic fragment lists execute normally but remain unchecked by the optional
[source checker](query-checking.md#supported-composition). Test their meaningful variants against
the database. Fixed queries are easier to follow when composition is unnecessary.

## Select names and SQL syntax safely

Values and identifiers are different. Use `identifier` for approved schema/table/column names:

```ts
import { identifier } from '@kequtech/tenon-orm';

const table = identifier('public', 'users');
const query = sql<{ id: number }>`SELECT id FROM ${table} WHERE active = ${true}`;
```

This quotes `"public"."users"` as two components. It does not authorize access; map application
choices to approved names before using it. Each component must contain 1–63 UTF-8 bytes and no NUL.

Choose SQL syntax such as sort direction from fixed alternatives:

```ts
const descending = true;
const direction = descending ? sql.fragment`DESC` : sql.fragment`ASC`;
const query = sql<{ id: number }>`SELECT id FROM public.users ORDER BY id ${direction}`;
```

Interpolating the string `'DESC'` binds a value and does not create SQL syntax. Complete `sql`
queries cannot be nested; use fragments for partial statements.

## Execute SQL supplied by another component

```ts
import { unsafeSql } from '@kequtech/tenon-orm';

const query = unsafeSql<{ id: number }>('SELECT id FROM public.users WHERE email = $1', [email]);
```

Use trusted SQL text and an explicit values array, including `[]` when there are no parameters.
Never concatenate request data into the text. Tenon executes one statement per query; migrations
have a separate multi-statement runner. For an adapter inside a transaction, see
[transactional result adapters](reference.md#adapting-transactional-results).
