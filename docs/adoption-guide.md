# Adopting Tenon

Replace application queries independently of migration ownership. Tenon can query an existing schema
and generate types while the current migration runner stays in place. For a Tenon version upgrade,
read the [Changelog](../CHANGELOG.md) and [0.2.x-to-0.3.0 guide](upgrading-to-0.3.md).

## Preserve connections and behavior

Keep the existing database URI, credentials, TLS requirements, schema, and data. Tenon can add
driver settings through pg configuration:

```ts
import { createTenon } from '@kequtech/tenon-orm';

const db = createTenon({
  connection: {
    connectionString: existingUri,
    connectionTimeoutMillis: 5000,
  },
});
```

Translate old driver configuration into pg `PoolConfig` rather than passing it through. Pool
timeouts use milliseconds. Preserve runtime `search_path` through the pg startup options string, for
example `options: '-c search_path=app,public'`. URI startup options take precedence when both are
supplied. CLI `--namespace` does not change runtime queries. See
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
3. Review value conversions against [Tenon's mappings](reference.md#generated-types-and-checking):
   numeric values, dates, arrays, and JSON serialization may differ from the previous driver.
   Generated declarations do not replace domain validation.
4. Inspect meaningful completed query variants and run database assertions for actual rows,
   permissions, write effects, and rollback. See [query inspection](query-inspection.md).
5. Remove unused runtime dependencies and generated code after their callers are gone. Dependencies
   retained by other application code or installed transitively may still be needed.

Check cardinality when replacing a first-row accessor. `oneOrNone` rejects multiple rows and `one`
also rejects zero rows. Use deterministic `ORDER BY` plus `LIMIT 1` when choosing one of several
matches is intended; modes do not add a limit.

Use `sql.insertValues` and `sql.assignments` to replace object-to-SQL utilities, checking omission,
default, null, and empty-input semantics. Generated `Rows.Insert`/`Rows.Update` types can replace
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
changes can alter it without schema drift. If an existing adoption guard hashes this text, retain
reviewed references for each supported generator version, derived from disposable replays of the
immutable checkpoint. See [legacy baseline guards](upgrading-to-0.3.md#legacy-baseline-guards).

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
