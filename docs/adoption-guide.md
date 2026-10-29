# Adopting Tenon

Replace application queries independently of migration ownership. Tenon can query an existing schema
and generate types while the current migration runner stays in place. For a Tenon version upgrade,
read the [Changelog](../CHANGELOG.md).

## Upgrade from Tenon 0.3.x

Tenon 0.4 uses pgclear 0.2.0 or later 0.x in place of pg. Keep the existing database, credentials,
migration history, and application query functions. With npm, update both packages together:

```sh
npm install @kequtech/tenon-orm@^0.4.0 @kequtech/pgclear@^0.2.0
```

Use the project's existing package manager and then review these boundaries:

1. Translate pg `PoolConfig` fields to pgclear `PoolOptions`, or replace a borrowed pg Pool with a
   pgclear Pool. A URI remains supported. Supply connection credentials explicitly; the driver does
   not read PG environment variables, pgpass, service files, or pg-specific URI options.
2. Keep Tenon `sql`, `QueryClient`, result modes, and callback transactions. Update native calls to
   pgclear APIs: use `queryClassic(text, values?)` for finished SQL, release acquired sessions, and
   close dedicated listeners separately. Tenon's sql tag is distinct from pgclear's native tag.
3. Review temporal strings, readonly result arrays, Uint8Array bytes, exact string integer/numeric
   arrays, and JSON/array inputs. Use `json(value)`, `param(value, codec)`, or encoded text; replace
   Date binds with an intended temporal string and plain bigint binds with exact strings. Command
   rowCount remains a number or null. See [value mappings](reference.md#generated-types-and-checking).
4. Regenerate database declarations against the intended development/test schema. Replace former
   `Rows['users']`, `Rows.Insert['users']`, and `Rows.Update['users']` accesses with
   `Database['users']['row']`, `Database['users']['insert']`, and `Database['users']['update']`.
   Review the generated diff and exclude exact generator output from formatting.
5. Run the project's typecheck and database tests for queries, transactions, JSON/arrays, and native
   integrations. Add optional source checking where composition is recoverable; optional patches
   and runtime-dependent SQL may remain unchecked. See [validation tools](reference.md#choosing-a-validation-tool).

If other code still uses pg directly, retain it until those callers are migrated. Updating Tenon
does not require transferring migration ownership or adopting a new baseline.

## Preserve connections and behavior

Keep the existing database URI, credentials, TLS requirements, schema, and data. Tenon can add
driver settings through pgclear configuration:

```ts
import { createTenon } from '@kequtech/tenon-orm';

const db = createTenon({
  connection: {
    connectionString: existingUri,
    connectTimeoutMs: 5000,
  },
});
```

Translate old driver configuration into pgclear `PoolOptions`. Pool timeouts use milliseconds.
Set `startupParameters: { search_path: 'app,public' }` for runtime names. pgclear does not read
PG environment variables, pgpass, or service files; supply connection settings explicitly. Preserve
credentials and verified TLS requirements. CLI `--namespace` does not change runtime queries. See
[connection options](reference.md#installation-and-connection).

Before conversion, identify behavior supplied by the old ORM: IDs/defaults, timestamps, validation,
hooks, serialization, relationships, and transaction boundaries. Preserve it explicitly in
application code or SQL where required.

## Replace queries

1. Optionally generate persistence types from the existing schema:

   ```sh
   npx tenon generate --namespace public --out src/generated-schema.d.ts
   ```

   This needs no Tenon migration history. Use the application's namespace and commit exact output.

2. Replace queries with parameterized SQL in ordinary functions accepting `QueryClient` where
   callers may supply `db` or `tx`. Retain projections, ordering, null handling, and authorization.
3. Review value conversions against [Tenon's mappings](reference.md#generated-types-and-checking).
   Pgclear 0.2.0 reads int8/bigserial and SQL count(*) as exact strings; command rowCount is a
   number. Replace plain bigint binds with strings or param(text, builtin.int8). Numeric values,
   dates, arrays, and JSON serialization may also differ from the previous driver. Regenerate
   declarations when mappings change; they do not replace domain validation.
4. Run the optional [source-aware checker](query-checking.md) for recoverable queries, inspect
   meaningful completed query variants, and run database assertions for actual rows, permissions,
   write effects, and rollback. See [query inspection](query-inspection.md).
5. Remove unused runtime dependencies and generated code after their callers are gone. Dependencies
   retained by other application code or installed transitively may still be needed.

Check cardinality when replacing a first-row accessor. `oneOrNone` rejects multiple rows and `one`
also rejects zero rows. Use deterministic `ORDER BY` plus `LIMIT 1` when choosing one of several
matches is intended; modes do not add a limit.

Use `sql.insertValues` and `sql.assignments` to replace object-to-SQL utilities, checking omission,
default, null, and empty-input semantics. Generated `Database[table]['insert']`/`Database[table]['update']` types can replace
handwritten persistence inputs. See the [mutation cookbook](mutations.md).

Use `tx.query` for work that must commit together. Native pool calls do not join Tenon transactions.
For driver features, preserve resource ownership and recovery policy under the
[native access contract](reference.md#native-driver-access).

## Transfer migration ownership

Choose one final checkpoint for the old runner. Bring existing databases to it and disable that
runner before handover; the runners do not share locks. Capture from a trusted reference database,
preferably a disposable replay of the legacy migrations.

### Capture a baseline

For an application owning `app` in a shared database:

```sh
npx tenon baseline capture --directory migrations --namespace app --schema app
```

The directory must contain no SQL files. Capture uses native
`pg_dump --schema-only --no-owner --no-privileges` and writes `0001_baseline.up.sql` with no down
file. Install compatible PostgreSQL client tools on PATH; prefer the server's major version.

| Option                | Scope                                                                                |
| --------------------- | ------------------------------------------------------------------------------------ |
| `--namespace app`     | Tenon history table to exclude from capture; history/runner scope for later commands |
| `--schema app`        | Objects selected by native `pg_dump`; repeat to select additional schemas            |
| Runtime `search_path` | Configured independently on the application connection                               |

Omitting `--schema` captures the whole database schema, even with a custom namespace. Capture does
not modify source data/history or preserve sequence positions. It excludes Tenon's selected history
table but can retain the old runner's metadata tables. Review and commit the SQL. Preserve the
capture header, which opts this reviewed dump into native baseline parsing; do not add it to
handwritten migrations.

A scoped dump can refer to objects it does not include. Provision external schemas, functions,
extensions, and referenced roles before they are needed. A fresh replay must execute representative
operations, not just reproduce generated relation types. Tenon requires no particular extension.

### Check and adopt an existing database

Verify the final legacy checkpoint before adoption. If using schema comparisons, freeze separate
reference definitions rather than comparing against types regenerated after later migrations.
`generateDefinitions` covers relation metadata, not functions or privileges; include reviewed
catalog checks for other objects the application needs. Tenon does not perform these comparisons.

Generated declaration text is not a version-stable schema fingerprint: driver mappings and generator
changes can alter it without schema drift. The schema-summary comments expose SQL definitions, but
their formatting and PostgreSQL's rendering of those definitions are not a stable comparison format
either. If an existing adoption guard hashes generated text, preserve its original reference and
freeze a separate reference for each supported generator version from a disposable replay of the
immutable checkpoint. Compare the replay's metadata with the reviewed checkpoint before accepting
the new reference; never derive a replacement from whichever live database is configured. Keep
independent function and privilege checks, and test both matching adoption and refusal after drift.
This application guard is separate from Tenon's migration checksums; keep applied SQL unchanged.

```sh
npx tenon baseline adopt --directory migrations --namespace app
npx tenon migrate --directory migrations --namespace app
```

Adoption records the baseline checksum without executing its SQL. The namespace must already exist.
Repeating matching adoption is harmless, including after later migrations; history conflicts fail.
Once Tenon owns history, add forward migrations rather than editing the baseline.

### Replay a fresh database

Run `tenon migrate --directory migrations --namespace app`, without adoption. It executes the same
committed baseline and subsequent migrations. Apply the deployment's required roles, ownership, and
grants before application access.

The portable baseline omits ownership, grants/revokes, and default privileges. Objects are recreated
under the migration role. For `SECURITY DEFINER` functions, that owner controls execution authority,
and new functions ordinarily permit `PUBLIC` execution. Keep fixed policy such as revoking public
execution in reviewed baseline SQL before first adoption or in a forward migration. Deployment
provisioning supplies named roles, owners, and grants. Verify permitted and denied operations on
both adopted and fresh environments. See the
[pg_dump contract](https://www.postgresql.org/docs/16/app-pgdump.html).

For development, generate types after migrating; production runs migrations and consumes committed
types. Test existing-row preservation, repeatable adoption, subsequent migrations, and fresh replay.
A schema-only baseline and down migration are not backups. The missing down file prevents rollback
across the baseline; use the application's backup/recovery procedure for that boundary.

Programmatic capture is
`captureBaseline({ connection, directory?, namespace?, schemas?, onWarning? })` and returns
`{ id, upPath }`. It requires a native libpq connection string; an explicitly empty `schemas` list
fails. `adoptBaseline({ connection, directory?, namespace? })` accepts Tenon's runtime connection
forms and returns newly recorded IDs.
