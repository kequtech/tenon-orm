# Mutation cookbook

Use `sql.insertValues` and `sql.assignments` for object fields while keeping SQL structure visible.
The [reference](reference.md#object-based-mutation-fragments) defines the complete contract.
Examples assume an existing `db` and this table, with generated `Rows` from the same schema:

```sql
CREATE TABLE profiles (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  bio text DEFAULT 'unwritten',
  score integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 0
);
```

## Defaults, undefined, and null in batches

```ts
await db.query(
  sql`INSERT INTO profiles ${sql.insertValues([
    { name: 'Ada', bio: null },
    { name: 'Lin', score: 4, bio: undefined },
  ])} RETURNING id`,
  { returns: 'many' },
);
```

Ada gets the score default and SQL null for bio. Lin gets score 4 and the bio default. Columns stay
aligned across heterogeneous rows. Empty batches fail; a single default-only object emits
`DEFAULT VALUES` and still depends on the table's required-column rules.

## Input types and runtime validation

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';
import type { Rows } from './generated-schema.js';

type ProfileInput = Pick<Rows.Insert['profiles'], 'name' | 'score'>;

function createProfile(client: QueryClient, input: ProfileInput) {
  return client.query(
    sql<{ id: number }>`INSERT INTO profiles
    ${sql.insertValues(input, ['name', 'score'])} RETURNING id`,
    { returns: 'one' },
  );
}
```

Annotations, `satisfies`, or helper generic arguments apply generated input types; merely generating
the file does not check writes. Use `Pick` to narrow accepted fields and retain runtime validation.
Generated inputs describe defaults and driver representations, not authorization or constraints.

Selected columns choose and order fields, ignoring unlisted keys. They can discard a required field
even when the original object is valid:

```ts
const input: Rows.Insert['profiles'] = { name: 'Ada' };
const query = sql`INSERT INTO profiles ${sql.insertValues(input, ['bio', 'score'])}`;
// Executing this fails: name was discarded and has no default.
```

## Patches mixed with expressions

```ts
const patch: Pick<Rows.Update['profiles'], 'name' | 'bio'> = { bio: null };
await db.query(sql`UPDATE profiles SET ${sql.assignments(patch)}, revision = revision + 1
  WHERE id = ${id}`);
```

Missing/undefined fields are omitted; null clears a nullable field. Put arithmetic and
`column = DEFAULT` in SQL. Helpers accept values, not SQL expression objects.

An empty patch fails even if the surrounding SQL has other assignments. Branch when an
expression-only update is intended:

```ts
if (patch.name !== undefined || patch.bio !== undefined) {
  await db.query(sql`UPDATE profiles SET ${sql.assignments(patch)}, revision = revision + 1
    WHERE id = ${id}`);
} else {
  await db.query(sql`UPDATE profiles SET revision = revision + 1 WHERE id = ${id}`);
}
```

## Preserve an omitted field during an upsert

Given validated `name`, `score`, and optional `bio`, choose conflict behavior explicitly:

```ts
if (bio !== undefined) {
  await db.query(sql`INSERT INTO profiles ${sql.insertValues({ name, score, bio })}
    ON CONFLICT (name) DO UPDATE SET score = excluded.score, bio = excluded.bio`);
} else {
  await db.query(sql`INSERT INTO profiles ${sql.insertValues({ name, score })}
    ON CONFLICT (name) DO UPDATE SET score = excluded.score`);
}
```

The second query preserves an existing bio. Omitting an insert value uses its database default; that
alone does not decide which fields a conflict update overwrites.

## JSON and PostgreSQL arrays

For a table with `payload jsonb` and `tags text[]`, encode JSON separately from the PostgreSQL
array:

```ts
const tags = ['ada', 'lin'];
await db.query(
  sql`INSERT INTO deliveries ${sql.insertValues({ payload: JSON.stringify(tags), tags })}`,
);
```

Generated JSON writes accept encoded JSON strings. Use `JSON.stringify(value)` for objects, arrays,
strings, and JSON null; a bound JavaScript null means SQL null. Arrays passed directly are
PostgreSQL arrays. Tenon leaves serialization to pg.

## Batches in one transaction

For an array `rows` of generated profile inputs:

```ts
await db.transaction(async (tx) => {
  for (let offset = 0; offset < rows.length; offset += 300) {
    const batch = rows.slice(offset, offset + 300);
    await tx.query(sql`INSERT INTO profiles ${sql.insertValues(batch, ['name', 'bio', 'score'])}`);
  }
});
```

A failure rolls back all batches. Empty input makes no insert calls. Choose a batch size below the
query-wide 65,535-parameter limit, including surrounding parameters; default cells consume none.
Tenon does not split batches or choose transaction boundaries for you.
