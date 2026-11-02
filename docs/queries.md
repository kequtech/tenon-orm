# Queries, writes and transactions

[All guides](../README.md) · [Types and values](types.md) · [Reference](reference.md)

[Read and reuse](#read-and-reuse) · [Compose SQL](#compose-sql) · [Write objects](#write-objects) ·
[Transactions and write guards](#transactions-and-write-guards) · [Errors](#errors)

Examples use the `public.users` table and shared `db` from [getting started](getting-started.md).

## Read and reuse

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';

type UserSummary = { id: number; email: string };
export function userById(client: QueryClient, id: number) {
  return client.query(sql<UserSummary>`SELECT id, email FROM public.users WHERE id = ${id}`, {
    returns: 'oneOrNone',
  });
}
```

Call `userById(db, id)` or `userById(tx, id)`. Functions are the query abstraction; keep SQL, row
projection and execution options together. No model base class or relationship configuration is needed.

Interpolations become separately bound parameters. Do not quote them or mix manual `$1`
placeholders into a template. A constructed query is inert and exposes `.text` and `.values`.
`sql<Row>` declares one result row; without it field values are unknown. It performs no runtime
validation. Use unique selected names and quoted aliases for camelCase.

`returns: 'many'` returns an array, `oneOrNone` permits undefined, `one` requires exactly one row,
and the default `native` returns driver metadata and rows. Modes inspect actual returned rows;
they do not add LIMIT or RETURNING. An UPDATE without RETURNING can affect rows while returning none.

Write joins and aggregates in PostgreSQL:

```ts
const rows = await db.query(
  sql<{ id: number; total: string }>`
  SELECT u.id, count(p.id) AS total
  FROM public.users u LEFT JOIN public.posts p ON p.user_id = u.id
  GROUP BY u.id ORDER BY u.id`,
  { returns: 'many' },
);
```

This assumes `public.posts(user_id integer)` exists. `count(p.id)` counts matched posts; `count(*)`
would include the unmatched outer-join row. Both return bigint, decoded as exact text by default.
Outer joins can introduce null even when a source column is NOT NULL. Describe can help choose
representations, but your projection must reflect nullable joins and validate JSON structures.

For pagination, bind a validated cursor and limit and use a unique order:

```ts
const page = await db.query(
  sql<UserSummary>`SELECT id, email FROM public.users
  WHERE id > ${afterId} ORDER BY id LIMIT ${pageSize}`,
  { returns: 'many' },
);
```

Start integer IDs at zero if the schema guarantees positive IDs. For another sort column, carry it
and a unique tiebreaker in the cursor. Application validation bounds page size and authorizes access.

## Compose SQL

```ts
import { identifier, sql } from '@kequtech/tenon-orm';

const direction = descending ? sql.fragment`DESC` : sql.fragment`ASC`;
const filters = [sql.fragment`active = ${true}`];
if (email) filters.push(sql.fragment`email = ${email}`);
const query = sql<UserSummary>`SELECT id, email FROM public.users
  WHERE ${sql.join(filters, 'AND')} ORDER BY id ${direction}`;
```

Fragments bind values and cannot execute alone. `join` accepts nonempty fragments and AND, OR or
comma separators; it adds no parentheses. Keep required authorization predicates in every branch.
When every predicate is optional, choose a complete query without WHERE for the empty case.
Nested or repeated fragments retain parameter order. Full executable queries cannot be nested.

Use `identifier('public', approvedTable)` for names; each component is quoted separately. It does
not authorize access. Fixed fragments supply syntax such as DESC; interpolating the string `'DESC'`
binds a value. Each name must be 1–63 UTF-8 bytes with no NUL.

For trusted SQL supplied by another component, use `unsafeSql<Row>(text, values)`, including an
explicit empty values array. Never concatenate request values into SQL text. One query executes
one statement; migrations have a separate multi-statement runner.

Runtime loops and dynamic fragments are valid but can remain unchecked by the source checker.
[Checking](checking.md#supported-composition) describes supported finite composition and its limits.
Keep execution tests for meaningful alternatives.

## Write objects

Write table names, conditions, conflicts and RETURNING in SQL. Object helpers only build fragments:

```ts
const created = await db.query(
  sql<{ id: number }>`INSERT INTO public.users
  ${sql.insertValues({ email: 'ada@example.test' })} RETURNING id`,
  { returns: 'one' },
);

await db.query(
  sql`UPDATE public.users SET ${sql.assignments({ active: false })}
  WHERE id = ${created.id}`,
  { affectedRows: { exact: 1 } },
);
```

Missing/undefined insert fields use DEFAULT; assignments omit them. Null stays SQL NULL. A default-only
single insert emits DEFAULT VALUES; multiple default-only rows require explicit columns. Empty
batches and empty assignments reject. Put arithmetic or `column = DEFAULT` directly in SQL rather
than passing fragments as object values. A helper rejects an empty patch even if another assignment
appears outside it; branch or skip the helper when an expression-only update is intended.

Use generated insert/update types and select editable fields:

```ts
import type { Database } from './generated-schema.js';
type Editable = Pick<Database['users']['update'], 'email' | 'active'>;

function updateUser(client: QueryClient, id: number, patch: Editable) {
  return client.query(
    sql`UPDATE public.users SET ${sql.assignments(patch, ['email', 'active'])}
    WHERE id = ${id}`,
    { affectedRows: { exact: 1 } },
  );
}
```

Explicit columns select and order keys; unlisted fields are ignored. Selection can discard required
insert values, so preserve required columns. Without a list, inserts infer the first-seen union of
enumerable keys with defined values, while assignments use own enumerable keys. Helpers snapshot
own data properties; selected accessors reject. Plain/null-prototype objects are accepted. Do not
mutate bound values before execution settles.

Upsert behavior stays explicit. Omitting an insert field uses its default; it does not decide
whether a conflicting row should be overwritten. Branch when a missing patch must preserve a value:

```ts
if (patch.active === undefined) {
  await db.query(sql`INSERT INTO public.users (email) VALUES (${email})
    ON CONFLICT (email) DO NOTHING`);
} else {
  await db.query(sql`INSERT INTO public.users (email, active) VALUES (${email}, ${patch.active})
    ON CONFLICT (email) DO UPDATE SET active = excluded.active`);
}
```

Arrays and objects need explicit encoding. For an application table with JSONB and text[] columns:

```ts
import { builtin, json, param } from '@kequtech/tenon-orm';
await db.query(sql`INSERT INTO public.deliveries (payload, tags)
  VALUES (${json({ sent: false })}, ${param(['news', null], builtin.textArray)})`);
```

JSON arrays and PostgreSQL arrays differ. `json(null)` is JSON null; plain null is SQL NULL.
`json('text')` encodes a JSON string, not a pre-encoded document. JSON rejects bigint.
See [types and encodings](types.md).

For batches, use `insertValues(rows, columns)` and choose a size below the whole query's 65,535
parameter limit, including surrounding interpolations. DEFAULT cells consume no parameters. Tenon
does not split batches. Loop over chunks inside one transaction when all must commit together;
empty input should make no calls.

## Transactions and write guards

```ts
await db.transaction(
  async (tx) => {
    const user = await userById(tx, id);
    if (!user) throw new Error('User not found');
    await tx.query(sql`UPDATE public.users SET active = false WHERE id = ${id}`, {
      affectedRows: { exact: 1 },
    });
  },
  { isolation: 'serializable', timeoutMs: 5000 },
);
```

Every participating operation must use and await `tx`. Root `db` calls borrow another pool session
and commit independently. The callback commits on success, rolls back on an escaping error and
expires its client when it finishes. It provides no nested transaction method; manual savepoints
are supported on its session. Direct BEGIN/COMMIT/ROLLBACK queries are rejected.

`affectedRows` checks the final INSERT/UPDATE/DELETE/MERGE count: `{ exact: 1 }` requires one;
`{ max: 1 }` permits zero or one. At the database root a guard opens a transaction. Inside a callback
it uses a savepoint and rolls back the guarded operation before rejecting. You can catch a guard
failure and continue. An unguarded server error normally aborts the transaction; let it escape.
Whole guarded operations are serialized on that transaction, including savepoint handling.

Counts exclude additional trigger, cascade and CTE effects. A count of one cannot identify a wrong
row. Sequence advances and external effects can survive rollback. Result-cardinality errors alone
do not undo autocommitted writes; use an affected-row guard or explicit transaction for rollback.
Tenon never automatically retries callbacks.

## Errors

Use structured codes and fields, not message matching. `CardinalityError` describes returned-row
mismatches; `AffectedRowsError` describes guarded-count mismatches or unsupported commands. Driver
and PostgreSQL errors retain their original identity. Work and cleanup failures can form an
AggregateError; the [reference](reference.md#errors) lists Tenon's fields.

```ts
import { findDriverErrors } from '@kequtech/tenon-orm';

try {
  await persistResult(); // Application operation.
} catch (error) {
  if (findDriverErrors(error).some((e) => e.code === 'PGCLEAR_COMMIT_UNKNOWN')) {
    await reconcileByStableOperationId(); // Application policy, using authoritative storage.
  }
  throw error;
}
```

A rejected commit does not prove rollback. The helper returns original driver errors through causes
and aggregates, once each, without wrapping or logging. It skips getters and handles cycles. Each
outcome concerns one operation; even `confirmed` is not proof of a surrounding transaction's commit.
Absence of a commit-unknown error proves neither success nor rollback. Reconcile before repeating
external effects or deleting an uploaded object that a committed row may reference.
