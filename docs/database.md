# Configure, host and migrate a database

[All guides](../README.md) · [Getting started](getting-started.md) · [Reference](reference.md)

[Configuration](#configuration) · [Hosting](#hosting) · [Native driver access](#native-driver-access) ·
[Migrations](#migrations) · [Adopt an existing schema](#adopt-an-existing-schema)

## Configuration

Use one `TenonConfig` object for runtime and CLI. `tenon init` creates a named `main` export:

```ts
import type { TenonConfig } from '@kequtech/tenon-orm';

export const main = {
  connection: {
    connectionString: process.env.DATABASE_URL,
    maxConnections: 10,
    connectTimeoutMs: 5000,
    acquireTimeoutMs: 5000,
    idleTimeoutMs: 30000,
    startupParameters: { search_path: 'app,public' },
  },
  migrations: { directory: 'migrations', namespace: 'app' },
  generate: { out: 'src/generated-schema.d.ts' },
  check: { project: 'tsconfig.json' },
} satisfies TenonConfig;
```

This assumes schema `app` exists. Pass the object to `createTenon(main)`. Connection accepts a URI,
pgclear pool options, or an existing pool. Object fields override URI settings. Unknown options
reject. Keep deployment addresses/credentials in the existing environment or secret provider;
Tenon loads neither `.env` nor pgpass/service files.

Construction validates configuration shape but defers credentials and pool creation until a query,
transaction, worker operation or `db.native` access needs them. Closing an unused instance needs
no credentials. Read environment values without eager top-level credential checks so builds can
import the config safely. Values are captured when the config module is imported; supply them
before application startup. An explicitly missing/empty connection string fails when used. A
purposefully empty options object `{}` selects pgclear's local defaults.

Keep codecs in `connection.codecs` so runtime, generation and checking agree; [types](types.md#choose-representations)
explains representations. `startupParameters.search_path` controls runtime name resolution.
Tooling `namespace` selects metadata/history and does not change application queries.
Use `tls: {}` for verified TLS with system trust, or the provider's required CA/settings.
The installed driver's configuration reference documents every pool/TLS option.

### CLI selection and paths

Tenon finds the nearest `tenon.config.ts`, `.mts`, `.js` or `.mjs` in the current directory or its
parents. Multiple recognized files in that directory require `--config`. Import errors or missing
exports fail; the command never falls back to a different connection after a failure.

Export one config per database and select it with `--database name`. A file with one database export
selects it automatically; multiple exports require a name. Helper exports are ignored; a default
export can be selected as `default`. Runtime selects by ordinary import. Config imports evaluate
the whole module, although only the selected database settings are validated. Keep imports inert.

Configured paths resolve beside the config file. CLI path flags resolve from the working directory
and override configuration. The [reference](reference.md#configuration) lists fields and defaults.
Programmatic tools accept explicit options and never discover files. Source checking imports the
trusted config, then reads query modules without executing them. The TypeScript compiler loads only
for source checking, not ordinary runtime operations.

`generate`, `check`, `describe` and `schema` require config. Migration/baseline commands retain a
`DATABASE_URL` fallback only when no config is found. `init`, `new`, `jobs setup` and `--help` need
no database credentials; help imports no config. Config dependencies must run in Node without
bundler-only transformations or path aliases.

## Hosting

Reuse one database per process. Stop accepting requests, finish request work, stop/await workers
and dedicated listeners, then close the database:

```ts
try {
  await serveApplication(); // Your host owns process signals and request lifetime.
} finally {
  await db.close({ timeoutMs: 5000 });
}
```

Close immediately rejects new Tenon operations. An owned pool drains within the chosen grace,
then expires outstanding handles. The first valid close call fixes its timeout; later calls share
its promise and outcome. This bounds driver resources, not arbitrary JavaScript callbacks or proof
of remote rollback. See [Jobs hosting](jobs.md#run-and-close) when a worker shares the process.

If the application already owns a pgclear pool, pass it directly:

```ts
const db = createTenon({ connection: pool });
await db.close(); // Disables the wrapper; pool remains open.
await pool.close(); // Its owner closes it after all users finish.
```

Tools follow the same borrowed-pool ownership rule. Budget connections for request queries, handler
transactions, queue maintenance and dedicated listeners. Definition concurrency is not pool sizing.

`onQuery(event)` on the config observes completed Tenon queries, including labels and duration.
Callbacks are not awaited; observer throws/rejections warn without altering outcomes. SQL and bound
values are excluded. Native calls bypass Tenon guards/observations; driver telemetry covers those.

## Native driver access

`db.native` is the exact pgclear pool. Use native pgclear APIs for preparation, row streams, COPY,
reserved sessions or LISTEN. Install pgclear directly only when the application imports its APIs;
use one compatible resolved driver across Tenon and Jobs. Tenon's SQL tag differs from the native
tag: use `queryClassic(query.text, query.values)` for a completed Tenon query or alias native tags
explicitly. Native work does not join an ORM transaction merely because it uses the same pool.

When adapting an ORM query to a consumer expecting driver results, use
`tx.query(query, { returns: 'native' })`; keep the adapter scoped to the supplied `Transaction`,
rather than pretending it is a full database with lifetime/pool methods.

Listeners own dedicated connections and close separately. Reuse connection values, not pool-only
options, when calling native listen. The driver's [connection](https://github.com/kequtech/pgclear/blob/17fae30540cbc41ce2c776645437c6d265e2de96/docs/connections.md)
and [notification](https://github.com/kequtech/pgclear/blob/17fae30540cbc41ce2c776645437c6d265e2de96/docs/notifications.md) guides own
native configuration, registration/reconnect and shared-listener examples. Tenon adds no listener
or streaming wrapper.

## Migrations

Keep an existing runner if it already owns schema changes. Tenon's optional runner uses numbered
SQL files; [getting started](getting-started.md#create-a-table) shows the first pair.

```sh
npx tenon new add_user_index
npx tenon migrate
npx tenon status
npx tenon rollback --steps 1
```

IDs are zero-padded numeric prefixes; an up file is required and a down file is optional. Fill new
drafts before applying them. Files are sorted numerically and IDs/names must be unambiguous. Applied
checksums include both directions and their exact saved text. Restore changed historical files;
make corrections in a new forward migration. Removing an applied down file also changes history.

Each migration commits separately under a session advisory lock. If a later file fails, earlier
files remain applied. The runner owns transactions: handwritten SQL cannot contain transaction
control or commands that require running outside transactions, such as CREATE INDEX CONCURRENTLY.
Statements are scanned before applying; server failures roll back the current file. Use direct or
session pooling for tooling locks. Rollback validates the selected applied files/down scripts first,
then reverses one file per transaction; it is not a whole-batch undo.

Applying pending migrations creates the namespace if needed. History is stored in its `__tenon_migrations` table; runtime search path
is separate. Migration/history queries use default decoding even with application codec overrides.
Run `generate` after migrations commit; it cannot see an uncommitted schema on another session.

For Jobs, `tenon jobs setup` creates offline installation SQL. It does not migrate storage on startup
or upgrade existing installations. [Jobs storage](jobs.md#install-storage) covers the explicit
application-owned upgrades and permissions.

## Adopt an existing schema

`tenon migrate` handles fresh installation and adoption through the same command. First bring the
source to the old runner's final checkpoint, stop that runner and freeze DDL. Capture once from
that reviewed source into an empty Tenon migration directory:

```sh
npx tenon baseline capture --namespace app --schema app --connection "$DATABASE_URL"
```

Capture writes `0001_baseline.up.sql` and `0001_baseline.checkpoint.json`. Review and commit both;
verify the SQL on disposable fresh storage. The SQL and catalog checkpoint share one exported
repeatable-read snapshot. The checkpoint records the migration namespace, SQL checksum, PostgreSQL
major and captured schema metadata, with its own content hash. It stores no rows or credentials.
Keep the pair immutable; later changes belong in new migrations.

Deploy with the usual command on every database:

```sh
npx tenon migrate --namespace app
```

When the captured baseline is pending, migrate validates its checkpoint and checks the captured
schemas under the exclusive migration lock, before creating history:

| Target state                                                     | Result                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| All captured schemas absent or empty of application objects      | Execute the baseline SQL                                         |
| Existing schema matches the source checkpoint                    | Record the baseline without executing it; preserve data          |
| Existing schema differs, including partially initialized storage | Stop with object/property differences; write no baseline history |
| Tenon history already exists                                     | Validate applied checksums and run pending migrations normally   |

Both successful initial paths record `0001`, then apply later migrations in order. Returned IDs
include a baseline recorded through adoption. Each file commits separately; a later failure can
leave the baseline recorded. Subsequent runs validate migration-file checksums and apply pending
files; they do not recheck the live schema. For later schema drift, compare against a snapshot from
fresh storage with all current migrations applied, using [schema comparison](checking.md#schema-checkpoints).
The original baseline is no longer the expected schema after later migrations.
Missing, corrupt or mismatched checkpoints refuse initial migration on fresh and existing storage.
Handwritten migrations without the captured-baseline header retain normal execution behavior.

Omitting `--schema` captures every user schema, regardless of migration namespace; the checkpoint
covers that same scope. A scoped capture leaves unrelated schemas alone. The migration namespace
must match capture, but may be separate from the schemas containing application tables. Use direct
or session connections. Capture requires compatible native `pg_dump` tools and a PostgreSQL URI
usable by both pgclear and pg_dump; deployment needs only pgclear, with no native client tools.
`baseline.connection` supplies that URI when runtime connection options are an object.
The dump's zero `transaction_timeout` setting is applied only when the target supports it. This also
works for older captured pairs during replay, preserving saved files and checksums. SQL object
bodies are unchanged; other SQL still needs to be supported by the target.

Repeat `--exclude-table pattern`, configure `baseline.excludeTables`, or pass `excludeTables` to
`captureBaseline` to omit legacy tables from fresh-install SQL while retaining their live storage.
CLI exclusions replace the configured list. Patterns use native pg_dump syntax: use qualified names
such as `public.kysely_migration`, quoting identifier components inside the pattern for literal mixed
case, dots or wildcards. Owned sequences may need separate exclusions. Review dependent views and
verify replay. **Excluded objects remain in the source checkpoint**, so adoption verifies the legacy
schema retained for transfer; fresh installs omit it. Tenon's history is ignored during comparison.
Exclusions never perform live cleanup.

The checkpoint compares [version-1 relation/type metadata](checking.md#schema-checkpoints), object
names, and function, view, trigger and rule definitions. Row contents and sequence positions are
ignored. PostgreSQL version metadata is recorded but does not block adoption; schema definitions
are still compared. The narrow CHECK text-array/varchar-array cast equivalence is accepted.
Other unsupported deparser differences stop adoption.
It does not establish owners, grants, RLS policy, legacy ledger contents, external dependencies or
complete extension/foreign/custom-type definitions. Verify those application-specific contracts
separately and keep external DDL frozen: other runners do not share Tenon's lock.

Capture omits owners, grants and default privileges. Fresh objects belong to the migration role;
verify SECURITY DEFINER ownership and PUBLIC execution on fresh and adopted storage. Provision
external schemas, extensions and roles required by scoped SQL. Test application workflows and
permissions on both paths. Never regenerate a checkpoint from a mismatched deployment target merely
to make it pass.
