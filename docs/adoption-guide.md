# Adopting Tenon from another ORM

This guide covers replacing an existing ORM and, separately, transferring migration ownership. For a
query tutorial use the [human guide](human-guide.md); for API details use the
[reference](reference.md). Preserve the existing schema, connection configuration, data, and
application behavior while replacing the old ORM. Tenon does not need to own migrations to execute
queries or generate types; keep the existing migration runner if that is the intended scope.

## Replace application queries

1. Locate the old ORM's connection setup, schema, migrations, and call sites. Identify behavior
   supplied by the ORM: validation, IDs, timestamps, hooks, defaults, relation loading,
   serialization, and transaction boundaries.
2. If row and mutation input types will help your application, generate them from the existing database:

   ```sh
   npx tenon generate --out src/generated-schema.d.ts
   ```

   Use `--namespace name` for a non-public schema. Generation reads the actual database and requires
   no Tenon migration history.

3. Replace queries with parameterized SQL in ordinary functions with named object inputs where
   useful. Preserve each caller's projection, null handling, ordering, and transaction behavior.
   Generated types describe Postgres.js values: check bigint/numeric strings, dates, JSON, and arrays when
   the old ORM transformed them.
4. Inspect completed queries and test their behavior using the
   [inspection workflow](#inspect-queries-during-adoption) below. Declare result types explicitly
   and run tests against a dedicated test database. Verify
   writes and rollback, relationships, validation, and any hooks you moved into application code or
   SQL. A schema-preserving first release makes application rollback easier.
5. Remove the old runtime dependency and unused generated code after its callers are gone. Keep the
   migration tooling until the migration transition below is complete, if that transition is part of
   the work.

## Replace local write helpers

Use `sql.insertValues(rows)` and `sql.assignments(patch)` in place of local object-to-SQL utilities:

```ts
import { sql } from '@kequtech/tenon-orm';

const insert = sql`INSERT INTO profiles ${sql.insertValues(rows)} RETURNING id`;
const update = sql`UPDATE profiles SET ${sql.assignments(patch)} WHERE id = ${id}`;
```

Compare omission, defaults, nulls, and empty-input behavior with the old helpers. Keep expressions
in SQL and remove the local utilities after their callers move. Generated `Rows.Insert` and
`Rows.Update` types can replace handwritten table inputs; retain application-specific refinements
and validation. Run the existing write and rollback workflows. See the [mutation cookbook](mutations.md).

## Inspect queries during adoption

Use `describeQuery` from `@kequtech/tenon-orm` on the completed query object, or
`npx tenon describe query.sql` on a SQL file. Inspection is available with the normal Tenon
installation and uses no TypeScript compiler API. It works with helpers and runtime-built
fragments because it receives the final SQL. See [query inspection](query-inspection.md).

Reuse the application's connection URI and session configuration; compare the reported role,
search path, and timezone with execution. Inspection uses a separate connection and Postgres.js
read mappings. Custom parsers and transaction-local state remain application responsibilities.

Pair descriptions with durable database tests of actual rows and effects. For each converted
query, cover the meaningful filter/ownership branches, null relationships, JSON structure, empty
results, ordering/cursors, and transaction failure/replay behavior as applicable. Describe's success
does not verify a TypeScript annotation or prove that execution is permitted or succeeds. Preserve
existing authorization policy and transaction boundaries while making queries available to tests.

Keep these tests in routine validation. A described query instance does not cover untested source
queries or detect stale annotations elsewhere.

## Move migration ownership to Tenon

Choose one final schema checkpoint for the old runner and bring existing target databases to it.
Disable its migration/schema synchronization before handing ownership to Tenon. The tools do not
share locks.

Capture one baseline from the reference database into an empty migration directory:

```sh
npx tenon baseline capture --directory migrations --namespace public
```

This uses native `pg_dump --schema-only --no-owner --no-privileges` and writes
`0001_baseline.up.sql` without a down file. It requires a compatible `pg_dump` on PATH; prefer the
server's major. Default scope is the whole database schema. Repeat `--schema name` to select schemas
explicitly, accounting for dependencies, extensions, and required roles. Tenon's selected history
table is excluded; old ORM metadata is preserved for deliberate cleanup later.

Capture changes no source data, migration history, or sequence positions. Review and commit the SQL.
Keep the capture header: it identifies native dump SQL that bypasses the authored-migration scanner.
It is a convention, not proof of provenance; do not use it on handwritten migrations. Normal
transactional execution and checksums still apply.

On each existing database already at that checkpoint:

```sh
npx tenon baseline adopt
```

Adoption records the baseline checksum without executing the SQL or comparing schemas. It requires
the selected namespace to exist. Repeating matching adoption is harmless, including after later
migrations; conflicting history fails.

On a fresh database, run migrations instead:

```sh
npx tenon migrate
```

That executes the baseline and subsequent migrations. Use the same committed baseline for every
environment. Do not run adoption unconditionally on fresh databases. Existing databases adopt once
and then use ordinary `migrate`.

Use the development [`db:migrate` script](human-guide.md#create-a-table) to apply subsequent
migrations and update table types together. Production continues to run only `npx tenon migrate`.
Verify both an existing database's upgrade and a fresh replay. Baselines contain schema only; they
do not back up rows or sequence positions. The missing down file prevents normal rollback through
the baseline. Keep the application's backup and recovery procedure.

Programmatic equivalents:

- `captureBaseline({ connection, directory?, namespace?, schemas?, onWarning? })` requires a
  nonempty native libpq connection string and returns `{ id, upPath }`. Omit `schemas` for the whole
  database schema; an explicitly empty list is rejected.
- `adoptBaseline({ connection, directory?, namespace? })` accepts the usual Tenon connection options
  and returns newly recorded migration IDs.
