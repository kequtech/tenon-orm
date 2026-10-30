# Adopting Tenon

You can replace application queries without changing migration ownership. Tenon queries and type
generation work with an existing schema and any migration runner. For a Tenon upgrade, read the
[shipped changelog](../CHANGELOG.md) from your resolved version through the target version.

## Preserve connections and behavior

Reuse the existing database URI, credentials, schema, TLS requirements, and data. Pool configuration
uses pgclear options; timeout names include `Ms`. Configure runtime names with
`startupParameters: { search_path: 'app,public' }`, or qualify tables in SQL. Tooling `namespace`
does not configure runtime queries.

Before replacing an ORM, identify behavior it currently supplies: IDs/defaults, timestamps,
validation, hooks, serialization, relationship loading, and transaction boundaries. Preserve needed
behavior in application code, constraints, or SQL. Tenon has no model lifecycle or implicit loading.

## Replace queries

1. Optionally generate persistence types with
   `await db.generateTypes({ out: 'src/generated-schema.d.ts', namespace: 'public' })`.
   Use the application's schema and codec registry; no Tenon migration history is required.
2. Replace one workflow at a time with parameterized SQL in ordinary functions. Accept
   `QueryClient` when callers may use either `db` or `tx`. Preserve selected columns, ordering,
   null handling, authorization predicates, and transaction boundaries.
3. Review input/output mappings and validate domain values at the persistence boundary. Generated
   types do not validate JSON members or application constraints.
4. Test actual rows, writes, permissions, and rollback. Use source checking and inspection where
   useful. See [choosing a validation tool](reference.md#choosing-a-validation-tool).
5. Remove unused dependencies/generated code once all their callers are gone.

When replacing a first-row accessor, decide whether multiple matches should be an error.
`oneOrNone` rejects multiple rows and `one` also rejects absence. To choose one match deliberately,
author deterministic `ORDER BY ... LIMIT 1`; result modes do not add a limit.

For object-to-SQL utilities, review omission, defaults, null, and empty patches against
[the write guide](mutations.md). Use `tx.query` for every operation that must commit together;
native pool calls do not join Tenon transactions.

## Transfer migration ownership

Choose the old runner's final schema checkpoint. Bring every existing database to it and disable
that runner before handover; the runners do not share locks. Capture one baseline from a trusted
reference database, preferably a disposable replay of the old migrations.

### Capture a baseline

For an application owning `app` in a shared database:

```sh
npx tenon baseline capture --directory migrations --namespace app --schema app
```

The directory must contain no SQL files. Capture uses native
`pg_dump --schema-only --no-owner --no-privileges` and writes `0001_baseline.up.sql` without a down
file. Install compatible PostgreSQL client tools on PATH, preferably matching the server's major
version. Capture does not modify source data or history and does not preserve sequence positions.

| Setting               | What it selects                                                         |
| --------------------- | ----------------------------------------------------------------------- |
| `--namespace app`     | Tenon history table to exclude; history/runner scope for later commands |
| `--schema app`        | Schema objects included by pg_dump; repeat for more schemas             |
| Runtime `search_path` | Application name resolution, configured separately                      |

Omitting `--schema` captures the whole database schema, even with a custom namespace. The selected
Tenon history table is excluded; old-runner metadata tables may remain. Review and commit the SQL.
Preserve the capture header: it opts this reviewed dump into native baseline parsing. Do not add
that header to handwritten migrations.

A scoped dump may depend on objects outside its scope. Provision required external schemas,
extensions, functions, and roles. Fresh replay must exercise representative application operations,
not merely reproduce table types. Tenon itself requires no particular extension.

### Check and adopt an existing database

Confirm that each existing database matches the reviewed final checkpoint. Tenon does not compare
the live schema with the baseline. Adoption records its checksum without executing its SQL:

```sh
npx tenon baseline adopt --directory migrations --namespace app
npx tenon migrate --directory migrations --namespace app
```

The namespace must already exist. Repeating adoption with matching history is harmless, including
after later migrations; conflicting history fails. Once adopted, leave the baseline unchanged and
add forward migrations.

For an application-owned schema guard, keep a frozen checkpoint reference. Generated relation types
do not cover functions or privileges; check required objects separately. Neither generated text nor
schema-summary formatting is a version-stable fingerprint. If a guard hashes that text, preserve
its original reference and freeze a separate reviewed reference for each generator version, taken
from a disposable replay of the immutable checkpoint. Verify that replay against the checkpoint
before accepting the reference; do not derive it from whichever live database is configured.
Test both matching adoption and refusal after drift. This is separate from migration checksums.

### Replay a fresh database

```sh
npx tenon migrate --directory migrations --namespace app
```

Do not adopt a fresh database. Migration executes the committed baseline and subsequent files.
The dump omits ownership, grants/revokes, and default privileges; objects are recreated under the
migration role. Deployment provisioning must supply required roles, owners, and grants.

For `SECURITY DEFINER` functions, the recreated owner controls authority. PostgreSQL ordinarily grants
`PUBLIC` execution on new functions. Put fixed policy such as revoking public execution in reviewed
baseline SQL before first adoption, or in a forward migration. Supply deployment-specific role names
and grants during provisioning. Verify permitted and denied operations on adopted and fresh databases.

Test preserved existing rows, repeatable adoption, later migrations, and fresh replay. A schema-only
baseline is not a backup; the missing down file prevents rollback across it. Use the application's
backup/recovery procedure for that boundary.

### Baseline API

- `captureBaseline({ connection, directory?, namespace?, schemas?, onWarning? })` returns
  `{ id, upPath }`. Connection is a native libpq connection string passed to pg_dump. Omitting
  `schemas` captures the whole database schema; an empty list rejects. Warnings default to
  `console.warn`.
- `adoptBaseline({ connection, directory?, namespace? })` accepts Tenon's runtime connection forms
  and returns newly recorded IDs. It requires `0001_baseline.up.sql` with no down file.

Defaults are directory `migrations` and namespace `public`. See [migrations](migrations.md) for
history validation, per-file transactions, and locking.
