# SQL migrations

Tenon's optional runner applies numbered SQL files and records their checksums in the database. It
can be used independently of query execution and type generation. Keep an existing runner unless
you intend to [transfer migration ownership](adoption-guide.md#transfer-migration-ownership).

## Create and apply a change

```sh
npx tenon new add_user_display_name
```

`new` works offline. It creates the next numeric pair in `migrations/`, starting at `0001` in an empty
directory. For a directory whose latest migration is `0001`:

```sql
-- migrations/0002_add_user_display_name.up.sql
ALTER TABLE public.users ADD COLUMN display_name text;
```

```sql
-- migrations/0002_add_user_display_name.down.sql
ALTER TABLE public.users DROP COLUMN display_name;
```

Set `DATABASE_URL` through your environment, then run:

```sh
npx tenon status
npx tenon migrate
```

`status` prints JSON with `applied` and `pending` ID arrays. `migrate` applies every pending up file
in numeric order and reports completed IDs. No pending files means nothing changes. No command
loads `.env` automatically.

After migrating a development database, [generate types](schema-types.md#generate-and-check-a-file),
review the diff, and commit migrations with generated declarations. Production applies migrations
and deploys the already-built application. Use a dedicated migrated database for tests.

## File rules and history

Files use `<numeric-id>_<name>.up.sql` and optional matching `.down.sql`. Names contain letters,
digits, underscores, or hyphens. Each ID has one name and an up file. SQL files with invalid names,
empty contents, duplicate numeric IDs, or down files without an up file fail validation.

The runner records ID, name, checksum, and application time in `<namespace>.__tenon_migrations`.
Checksums cover both up SQL and the presence/content of down SQL. Never edit, rename, remove, or
add a down file to an already-applied migration. Add a new forward migration instead. History must
match the beginning of the ordered file list; inserting an older migration also causes a conflict.

Migrations may contain multiple statements. Tenon owns the transaction, so authored files must not
contain transaction-control statements. Use dollar-quoted bodies for functions and explicit `E'...'`
for backslash escapes. A scaffold's files are empty until you fill them; both are checked even if
only the up direction is about to run.

## Transaction and failure behavior

Each migration file and its history entry commit together. The whole run is not one transaction:
if file three fails, files one and two may already have committed. Correct the cause, inspect
`status`, and rerun. The failed file is rolled back and remains pending. Restore original applied
files if history validation reports a conflict.

SQL that cannot run in a transaction, such as `CREATE INDEX CONCURRENTLY`, needs a separate,
application-owned procedure. Tenon has no nontransactional migration flag. It also does not infer
schema changes or generate migration SQL from TypeScript.

## Roll back

```sh
npx tenon rollback
npx tenon rollback --steps 2
```

Rollback runs the most recent down files in reverse order and removes their history records. It
prechecks that every selected migration has down SQL before executing any. `steps` must be a
positive safe integer; requesting more steps than exist selects all applied migrations.

For an irreversible change, omit the down file before first application. The missing file prevents
rollback across that migration. A down migration is not a backup: dropped data and sequence changes
may not be recoverable. Use the application's backup and recovery procedure when needed.

## Directory, schema, and locking

Defaults are `--directory migrations` and `--namespace public`. For a custom schema, use the same
options consistently:

```sh
npx tenon new add_setting --directory db/migrations
npx tenon migrate --directory db/migrations --namespace app
npx tenon status --directory db/migrations --namespace app
npx tenon rollback --directory db/migrations --namespace app --steps 1
```

The namespace selects history location, migration search path, and lock scope. During a file,
`search_path` is `<namespace>, pg_catalog`; qualify cross-schema names explicitly. The runner creates
the namespace when applying pending migrations. It does not configure runtime application queries.
Pass the matching namespace to type generation when generating that schema.

Migration and adoption operations use an exclusive session advisory lock for this database and
namespace. Status and generation use a shared lock. Different namespaces have independent lock
scopes. These locks do not coordinate with a legacy runner or arbitrary DDL.

Use direct or session-pooled connections for these tools; transaction pooling does not preserve
their session locks. Configure server timeouts on the tooling connection to bound waits. Migration
commands do not accept Describe's timeout flags.

Offline file creation uses `.tenon-create.lock` in the directory. Remove a stale lock only after
confirming that the process which created it has stopped. Baseline capture uses this local lock
and `pg_dump`; it does not take the runner's database advisory lock.

## Existing databases

An existing schema needs no baseline merely to execute queries or generate types. A baseline is
needed when Tenon takes over migration history: capture one reviewed schema at the old runner's
final checkpoint, record it on existing databases without execution, and execute it on fresh ones.
Follow [the adoption workflow](adoption-guide.md#transfer-migration-ownership).

## Programmatic API

```ts
import { migrate, migrationStatus, rollback } from '@kequtech/tenon-orm';

const options = { connection, directory: 'migrations', namespace: 'public' };
const before = await migrationStatus(options); // { applied, pending }
const applied = await migrate(options); // readonly string[] of completed IDs
const reverted = await rollback({ ...options, steps: 1 });
```

`connection` accepts the same URI/options/pool forms as `createTenon`. A supplied pool retains
application ownership. `createMigration({ name, directory? })` returns `{ id, upPath, downPath }`;
`readMigrations(directory?)` returns validated `{ id, name, up, down?, checksum }` records.
See [the command reference](reference.md#command-reference) for all CLI forms.
