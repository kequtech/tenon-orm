# Writing data

Write `INSERT`, `UPDATE`, `DELETE`, and `ON CONFLICT` in SQL. Use `sql.insertValues` and
`sql.assignments` when you have an object of field values; they return fragments for the column/value
parts of your statement. The [API reference](reference.md#object-based-mutation-fragments) defines
edge cases and validation rules.

Examples use an existing `db`, import `sql` from Tenon, and assume this table:

```sql
CREATE TABLE public.profiles (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  bio text DEFAULT 'unwritten',
  score integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 0
);
```

## Insert and return a row

```ts
import { sql } from '@kequtech/tenon-orm';

const profile = await db.query(
  sql<{ id: number; name: string }>`INSERT INTO public.profiles
    ${sql.insertValues({ name: 'Ada' })} RETURNING id, name`,
  { returns: 'one' },
);
```

The helper emits `("name") VALUES ($1)` and binds `'Ada'`. PostgreSQL fills defaults. You choose
`RETURNING` and the result mode explicitly.

## Defaults, undefined, and null

```ts
await db.query(
  sql`INSERT INTO public.profiles ${sql.insertValues([
    { name: 'Lin', bio: null },
    { name: 'Jo', score: 4, bio: undefined },
  ])}`,
);
```

Lin gets score 0 and SQL null for bio. Jo gets score 4 and the bio default. Heterogeneous rows stay
aligned. Missing/undefined insert cells use `DEFAULT`; explicit null remains SQL NULL.

A single default-only object emits `DEFAULT VALUES`, which still fails if the table has an unmet
required column. Empty batches fail. Multiple default-only rows need an explicit column list.

## Type and select accepted fields

Generate `Database` from the same schema, then narrow the fields the application accepts:

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';
import type { Database } from './generated-schema.js';

type ProfileInput = Pick<Database['profiles']['insert'], 'name' | 'score'>;

function createProfile(client: QueryClient, input: ProfileInput) {
  return client.query(
    sql<{ id: number }>`INSERT INTO public.profiles
      ${sql.insertValues(input, ['name', 'score'])} RETURNING id`,
    { returns: 'one' },
  );
}
```

The explicit column list selects and orders fields and ignores unlisted keys. Keep required insert
fields in that list: a well-typed object can still produce an invalid insert if selection discards
its required `name`. Helpers have no schema metadata; PostgreSQL enforces constraints.

Types apply through annotations, `satisfies`, or helper generic arguments. They do not validate
external data, authorization, JSON contents, or CHECK constraints. See
[generated inputs](schema-types.md#insert-and-update-inputs).

## Patch fields and use expressions

For a validated `id` and patch:

```ts
const patch: Pick<Database['profiles']['update'], 'name' | 'bio'> = { bio: null };
await db.query(
  sql`UPDATE public.profiles SET ${sql.assignments(patch)}, revision = revision + 1
    WHERE id = ${id}`,
  { affectedRows: { exact: 1 } },
);
```

Assignments omit missing/undefined fields. Null clears a nullable field. Put arithmetic,
`column = DEFAULT`, and other SQL expressions in the surrounding statement; helper cells accept
bound values, not SQL fragments or expression objects.

`sql.assignments` throws if no defined fields remain, even if the surrounding query has another
assignment. Skip an empty patch, or branch when an expression-only update is intended:

```ts
if (patch.name !== undefined || patch.bio !== undefined) {
  await db.query(
    sql`UPDATE public.profiles SET ${sql.assignments(patch)}, revision = revision + 1
    WHERE id = ${id}`,
    { affectedRows: { exact: 1 } },
  );
} else {
  await db.query(sql`UPDATE public.profiles SET revision = revision + 1 WHERE id = ${id}`, {
    affectedRows: { exact: 1 },
  });
}
```

## Upsert without overwriting an omitted field

For validated `name`, `score`, and optional `bio`, choose conflict behavior explicitly:

```ts
if (bio !== undefined) {
  await db.query(sql`INSERT INTO public.profiles ${sql.insertValues({ name, score, bio })}
    ON CONFLICT (name) DO UPDATE SET score = excluded.score, bio = excluded.bio`);
} else {
  await db.query(sql`INSERT INTO public.profiles ${sql.insertValues({ name, score })}
    ON CONFLICT (name) DO UPDATE SET score = excluded.score`);
}
```

The second branch preserves an existing bio. Omitting an insert field uses its database default;
it does not decide whether an upsert overwrites that field.

## Delete with a bound

```ts
await db.query(sql`DELETE FROM public.profiles WHERE id = ${id}`, {
  affectedRows: { max: 1 },
});
```

Zero or one deletion is allowed; more causes rollback. Use `exact: 1` when absence is also an error.
Guards work without `RETURNING`. See [transactions and guards](reference.md#transactions-guarded-writes-and-errors).

## JSON and PostgreSQL arrays

For an additional table with `payload jsonb` and `tags text[]`:

```ts
import { builtin, json, param } from '@kequtech/tenon-orm';

const tags = ['ada', 'lin'];
await db.query(sql`INSERT INTO public.deliveries
  ${sql.insertValues({ payload: json(tags), tags: param(tags, builtin.textArray) })}`);
```

`json(value)` encodes a JSON document; `param(value, codec)` chooses a PostgreSQL type and encoder.
A JSON array and a PostgreSQL array are separate formats. Generated writes accept encoded strings
or explicit parameters; plain objects/arrays reject. `json(null)` means JSON null, while plain
`null` means SQL NULL. `json('text')` encodes a JSON string, not an already-encoded document.
JSON encoding rejects bigint, including nested bigint values.

For int8, use exact strings, bigint, or `param('9007199254740993', builtin.int8)`. For an int8 array,
use `param(['9007199254740993', null], builtin.int8Array)`. Reads remain strings by default. Plain
Date and supported Temporal values work as scalar inputs; Date encodes in UTC. Neither input form
changes the output decoder. See [value mappings](schema-types.md#value-mappings).

## Batch within one transaction

For `rows` containing generated profile insert inputs:

```ts
await db.transaction(async (tx) => {
  for (let offset = 0; offset < rows.length; offset += 300) {
    const batch = rows.slice(offset, offset + 300);
    await tx.query(sql`INSERT INTO public.profiles
      ${sql.insertValues(batch, ['name', 'bio', 'score'])}`);
  }
});
```

A failure rolls back every batch; empty input makes no calls. Choose a batch size below the
query-wide 65,535-parameter limit, counting surrounding interpolations too. Default cells consume
no parameters. Tenon does not split batches or choose transaction boundaries.

These helpers support optional fields at runtime. The optional source checker needs explicit shape
types with required selected fields and fixed batch lengths; ordinary generated patch types can
remain unchecked. See [object expansion checking](query-checking.md#object-expansion).
