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

Use a column list to select and order fields in runtime-built rows:

```ts
import type { Rows } from './generated-schema.js';

const rows: Rows.Insert['profiles'][] = buildRows();
await db.query(sql`INSERT INTO profiles ${sql.insertValues(rows, ['name', 'bio', 'score'])}`);
```

This list selects and orders fields; unlisted fields are ignored. It does not assert that the
entire input object contains only allowed keys. Keep narrower application input validation.

`tenon generate` also provides `Rows.Update['profiles']`. Use `Pick` to limit a patch to fields
the caller may edit, for example `Pick<Rows.Update['profiles'], 'name' | 'bio'>`. Generated inputs
understand defaults, nullability, domains, and generated columns. They use write representations:
timestamps accept `Date | string`, bigint accepts `string | bigint`, and JSON uses serialized text.
See the [input-type reference](reference.md#insert-and-update-inputs) for the complete mapping.

## Input types, SQL checking, and runtime validation

Apply input types with an annotation, `satisfies`, or a helper generic argument. Generating the
file alone does not check every write. Narrow the fields each operation accepts:

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';
import type { Rows } from './generated-schema.js';

type ProfileInput = Pick<Rows.Insert['profiles'], 'name' | 'score'>;

function createProfile(client: QueryClient, input: ProfileInput) {
  return client.query(sql<{ id: number }>`INSERT INTO profiles
    ${sql.insertValues(input, ['name', 'score'])} RETURNING id`);
}
```

Here `id` and `score` are assumed to be integers. TypeScript rejects an incompatible typed input
such as `{ name: 'Ada', score: true }`. SafeQL checks selected columns and `RETURNING`; it does not
inspect runtime values. Validate external inputs before calling this function and keep database
constraints and application authorization in place.

**Selected columns can discard required fields.** For a table requiring integer `id` and text
`name` and `location`, this input is valid but the query fails:

```ts
const row: Rows.Insert['profiles'] = { id: 1, name: 'Ada', location: 'London' };
const query = sql`INSERT INTO profiles ${sql.insertValues(row, ['id', 'name'])}`;
// PostgreSQL rejects the insert: location was dropped and has no default.
```

A column list selects fields; it does not prove that all required fields will be written.

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

Use separate queries when an option changes conflict behavior:

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
versus array encoding from the table schema. Generated JSON input types use serialized text for
consistent handling of objects and arrays. Validate JSON contents in the application.

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
`at most 65535 bound parameters; received 65536`. Defaults consume no parameters. Account for the
selected columns and surrounding query when choosing a batch size; Tenon never splits queries automatically.
