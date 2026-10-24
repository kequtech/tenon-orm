# Mutation cookbook

Keep SQL structure visible and let the official helpers handle object fields. See the
[reference](reference.md#object-based-mutation-fragments) for the complete contract. Examples use
application-owned inputs and clients; add the authorization predicates required by your product.

## Defaults, undefined, and null in batches

```ts
await db.query(
  sql`INSERT INTO profiles ${sql.insertValues([
    { name: 'Ada', bio: null },
    { name: 'Lin', score: 4, bio: undefined },
  ])} RETURNING id`,
);
```

The first row uses the score default. The second uses the bio default. Explicit null in the first
row stays null. Columns are aligned across rows. Omit generated columns and let PostgreSQL enforce
required fields and constraints.

For runtime-built rows, supply an inline column list for SafeQL:

```ts
const rows: { name: string; bio?: string | null; score?: number }[] = buildRows();
await db.query(sql`INSERT INTO profiles ${sql.insertValues(rows, ['name', 'bio', 'score'])}`);
```

This list selects and orders fields; unlisted fields are ignored. It does not assert that the
entire input object contains only allowed keys. Keep narrower application input validation.

## Input types, SQL checking, and runtime validation

Suppose `profiles.score` is an integer column. An application-owned input type checks callers;
an inline column list lets SafeQL check the SQL even when the object is built at runtime:

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';

type ProfileInput = { name: string; score: number };

function createProfile(client: QueryClient, input: ProfileInput) {
  return client.query(sql<{ id: number }>`INSERT INTO profiles
    ${sql.insertValues(input, ['name', 'score'])} RETURNING id`);
}

function parseProfile(value: unknown): ProfileInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('score' in value) ||
    typeof value.score !== 'number' ||
    !Number.isInteger(value.score) ||
    value.score < 0 ||
    value.score > 100
  ) {
    throw new Error('Expected a profile name and an integer score from 0 to 100.');
  }
  return { name: value.name, score: value.score };
}

await createProfile(db, parseProfile(JSON.parse(requestBody)));
```

Here `id` is assumed to be a PostgreSQL integer. The guarantees are separate:

- A caller supplying `{ name: 'Ada', score: true }` to `createProfile` fails TypeScript checking. External JSON
  with those values throws in `parseProfile` before the query is built.
- A misspelled selected column such as `['name', 'socre']` fails TypeScript checking against
  `ProfileInput`. A key present in that type but absent from the database, such as adding
  `nickname: string` and selecting `'nickname'`, instead produces a SafeQL SQL diagnostic.
- Bypassing validation and supplying a boolean for `score` through untyped data is not a SafeQL
  input-type error. SQL analysis sees a parameter in an integer column's context, not the value.
  PostgreSQL rejects the incompatible value at execution. The same limitation applies to a
  numeric value outside the application's allowed range unless a database constraint enforces it.

SafeQL also checks the `RETURNING id` projection against the result annotation. None of these
checks establishes authorization, valid JSON contents in other columns, or nonempty runtime batches.

## Patches mixed with SQL expressions

```ts
await db.query(sql`UPDATE profiles
  SET ${sql.assignments({ name, bio })}, revision = revision + 1, score = DEFAULT
  WHERE id = ${id}`);
```

Undefined fields are omitted; null clears a field. Expressions, `DEFAULT`, and references to
`excluded.column` belong in SQL, not in mutation objects.

An empty patch throws even if the surrounding statement has other assignments. Choose an
expression-only query explicitly when that is the intended behavior:

```ts
const patch: { name?: string; bio?: string | null } = readPatch();
if (patch.name !== undefined || patch.bio !== undefined) {
  await db.query(sql`UPDATE profiles
    SET ${sql.assignments(patch, ['name', 'bio'])}, revision = revision + 1
    WHERE id = ${id}`);
} else {
  await db.query(sql`UPDATE profiles SET revision = revision + 1 WHERE id = ${id}`);
}
```

## Preserve an omitted field during an upsert

Use complete query variants when an option changes conflict behavior. Both templates can be
checked independently; the checker need not choose a JavaScript branch:

```ts
if (email !== undefined) {
  await db.query(sql`INSERT INTO preferences ${sql.insertValues({ profile_id, in_app, email })}
    ON CONFLICT (profile_id) DO UPDATE
    SET in_app = excluded.in_app, email = excluded.email`);
} else {
  await db.query(sql`INSERT INTO preferences ${sql.insertValues({ profile_id, in_app })}
    ON CONFLICT (profile_id) DO UPDATE SET in_app = excluded.in_app`);
}
```

The second query leaves an existing email value unchanged. Missing an insert field uses its
database default; that alone does not decide what an upsert should overwrite.

## JSONB arrays and PostgreSQL arrays

Tenon preserves pg's value conversion. A JavaScript array binds as a PostgreSQL array. To write an
array into a JSON/JSONB column, serialize it explicitly:

```ts
const handles = ['ada', 'lin'];
await db.query(
  sql`INSERT INTO deliveries ${sql.insertValues({
    recipients_json: JSON.stringify(handles), // jsonb column
    recipient_handles: handles, // text[] column
  })}`,
);
```

Objects used as JSON values retain pg's ordinary JSON conversion. The helper does not infer JSON
versus array encoding from the table schema. SafeQL's projection checks do not validate stored JSON
contents or runtime input values.

## Batches in one transaction

Choose the batch size in the caller and keep all writes on the transaction client:

```ts
await db.transaction(async (tx) => {
  for (let offset = 0; offset < rows.length; offset += 300) {
    const batch = rows.slice(offset, offset + 300);
    await tx.query(sql`INSERT INTO profiles ${sql.insertValues(batch, ['name', 'bio', 'score'])}`);
  }
});
```

A failure rolls back all batches. The helper rejects an empty batch; this loop makes no insert
calls for empty input. The query-wide limit is 65,535 bound parameters, including parameters outside
the mutation fragment. An oversized query reports its actual count, for example
`at most 65535 bound parameters; received 65536`. Defaults consume no parameters. Account for your selected column count and
surrounding query when choosing a batch size; Tenon never splits queries automatically.

Reusable authorization fragments remain valid at runtime. Keep shared policy in application
functions and test it rather than duplicating it for static coverage. Function-generated SQL,
conditional fragments, and dynamic filter lists remain outside static checking.
