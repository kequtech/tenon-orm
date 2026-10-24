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
2. If table row types will help your application, generate them from the existing database:

   ```sh
   npx tenon generate --out src/generated-schema.ts
   ```

   Use `--namespace name` for a non-public schema. Generation reads the actual database and requires
   no Tenon migration history.

3. Replace queries with parameterized SQL in ordinary functions with named object inputs where
   useful. Preserve each caller's projection, null handling, ordering, and transaction behavior.
   Generated types describe pg values: check bigint/numeric strings, dates, JSON, and arrays when
   the old ORM transformed them.
4. If using optional SQL checking, configure the
   [SafeQL integration](reference.md#sql-checking-with-safeql) and follow the
   [incremental audit workflow](#adopt-sql-checking-incrementally) below before accepting generated
   annotations. Run tests against a dedicated test database. Verify
   writes and rollback, relationships, validation, and any hooks you moved into application code or
   SQL. A schema-preserving first release makes application rollback easier.
5. Remove the old runtime dependency and unused generated code after its callers are gone. Keep the
   migration tooling until the migration transition below is complete, if that transition is part of
   the work.

## Upgrade object-write helpers from 0.1.0 to 0.1.1

Version 0.1.1 adds `sql.insertValues` and `sql.assignments`. Replace local utilities that render
object values with the official helpers after comparing their contracts:

```ts
// Before: application-owned SQL rendering.
import { sql } from '@kequtech/tenon-orm';
import { insertValues, assignments } from './sql.js';

const insert = sql`INSERT INTO profiles ${insertValues(rows)} RETURNING id`;
const update = sql`UPDATE profiles SET ${assignments(patch)} WHERE id = ${id}`;
```

```ts
// After: no local object-write utility import.
import { sql } from '@kequtech/tenon-orm';

const insert = sql`INSERT INTO profiles ${sql.insertValues(rows)} RETURNING id`;
const update = sql`UPDATE profiles SET ${sql.assignments(patch)} WHERE id = ${id}`;
```

Missing/undefined insert cells use database defaults; undefined update fields are omitted; null
remains null. Check heterogeneous batches and callers that previously allowed empty inputs or SQL
expressions inside objects: empty batches/updates and SQL-valued cells now throw. Keep expressions
in the surrounding SQL. See the [complete contract](reference.md#object-based-mutation-fragments)
and [mutation cookbook](mutations.md).

Run the application's typecheck and database workflows, including defaults, upserts, and rollback.
Delete the obsolete local module once all its callers have moved and any unrelated exports have
been preserved. This upgrade requires no schema or migration-ownership change. Existing result
annotations and input contracts still need their own verification. When adopting SafeQL, add
explicit inline selected columns to runtime-built inputs as described in the cookbook.

## Adopt SQL checking incrementally

For an existing application, including Next.js, SQL checking can run as a separate audit while the
normal lint/build commands keep their existing database requirements. Extend the existing flat
ESLint configuration rather than replacing it. After installing the
[checking dependencies](reference.md#install-and-configure), a single-database setup can use:

```js
// eslint.sql.config.mjs
import { defineConfig } from 'eslint/config';
import baseConfig from './eslint.config.mjs';
import safeql from '@ts-safeql/eslint-plugin/config';
import tseslint from 'typescript-eslint';
import { safeqlPlugin, eslintPlugin } from '@kequtech/tenon-orm/safeql';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for SQL checking');

export default defineConfig(baseConfig, {
  files: ['src/**/*.ts', 'src/**/*.tsx'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true },
  },
  plugins: { tenon: eslintPlugin },
  rules: { 'tenon/check-composition': 'error' },
  extends: [
    safeql.configs.connections({
      databaseUrl,
      plugins: [safeqlPlugin],
      targets: [{ tag: { regex: '.*' } }],
    }),
  ],
});
```

Preserve existing type-aware parser settings where configured. The broad target above lets Tenon
recognize aliases; use distinct targets for [multiple databases](reference.md#configuration-choices-and-multiple-databases).
The example does not load environment files. Use the application's existing environment loader
and URL selection to supply its migrated development/test database through `DATABASE_URL`.

```json
{
  "scripts": {
    "lint:sql": "eslint --config eslint.sql.config.mjs \"src/**/*.{ts,tsx}\""
  }
}
```

Start with `npm run lint:sql`. Keep both checking rules enabled and distinguish the findings:

- SQL errors identify problems in reconstructed SQL; review them before accepting inferred types.
- Missing/mismatched annotations may reflect an outdated type, a deliberate application refinement,
  or a checker limitation. They are not all demonstrated application bugs.
- `tenon/check-composition` means SQL analysis was skipped. Add inline selected columns for opaque
  mutation inputs where useful. Keep reusable authorization policy centralized when its fragments
  remain unsupported, with database tests for runtime variants.

Preview fixes on a small module first, without writing source. Invoke ESLint directly to select
one file, since the script above already supplies a source glob:

```sh
npx eslint --config eslint.sql.config.mjs src/database/profiles.ts --fix-dry-run --format json
```

Review the proposed annotations, apply selected changes deliberately, and run TypeScript and
database tests. Broader inferred types may require validation where raw database values enter the
application. For example, require a finite `Date` before calling `.getTime()`, validate structured
JSON from `unknown`, and justify CHECK-constrained string refinements with matching schema checks
or a reviewed column override. Do not globally map timestamps to `Date`: pg can return numeric
infinities. See [checker mappings](reference.md#supported-sql-and-limitations).

Known annotation limitations were reported with Tenon 0.1.1 and SafeQL 5.4.2:

- Nullable temporal annotations such as `Date | number | null` can be rejected even when expected
  and actual text match, and fixes can fail to converge. Preserve the driver-accurate type and
  isolate a reproduction rather than repeatedly applying fixes or narrowing it to `Date`.
- Direct indexed-access annotations such as `sql<Rows['profiles']>` can be rejected despite matching
  fields. A named alias, `type Profile = Rows['profiles']`, used as `sql<Profile>` passed the reported
  reproduction. It does not resolve separate temporal or JSON disagreements.
- Function nullability and catalog types can be inferred conservatively or incorrectly. Review
  advisory-lock and catalog-name projections separately rather than broadening every `unknown`.

Track accepted templates, annotation findings, and unsupported templates separately. An accepted
write without a returned projection says little about input values; an unsupported query has not
had its SQL verified. Counts cover only the selected files/templates, excluding `unsafeSql`, direct
driver calls, and runtime variants. Keep the audit's nonzero exit visible while findings remain;
promote it to a required CI check once its scope is intentionally resolved. Annotation fixes can
also invoke other inherited ESLint rules.

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
