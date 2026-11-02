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
options, when calling native listen. The driver's [connection](https://github.com/kequtech/pgclear/blob/main/docs/connections.md)
and [notification](https://github.com/kequtech/pgclear/blob/main/docs/notifications.md) guides own
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
version-1-to-2 upgrade and permissions.

## Adopt an existing schema

First replace query workflows without changing schema/migration ownership. Identify behavior the
old ORM supplied—defaults, timestamps, hooks, IDs, validation and transaction boundaries—and retain
needed behavior in application code, constraints or SQL. Verify rows, permissions and rollback.

To transfer migration ownership, bring all databases to one reviewed checkpoint and stop the old
runner. The runners do not share locks. Capture a trusted replay of its final schema:

```sh
npx tenon baseline capture --namespace app --schema app --connection "$DATABASE_URL"
```

The directory must contain no SQL files. Native `pg_dump --schema-only --no-owner --no-privileges`
writes `0001_baseline.up.sql` with no down file. Use compatible native client tools, preferably the
server's major version. Preserve required libpq authentication/TLS settings; Tenon does not convert
driver options into native settings. `baseline.connection` supplies a native URI when runtime
connection is an object. Omitted `--schema` captures the whole database, regardless of namespace.

Review and commit the SQL and its capture header; that header enables native baseline parsing.
Do not add it to handwritten migrations. Capture preserves no data or sequence positions. Provision
external schemas, functions, extensions and roles required by a scoped dump. Dumps omit owners,
grants and default privileges; fresh objects belong to the migration role. Verify SECURITY DEFINER
ownership and PUBLIC function execution deliberately on both adopted and fresh databases.

Before adoption, independently establish that the target matches the reviewed checkpoint:

```sh
npx tenon baseline adopt --namespace app
npx tenon migrate --namespace app
```

The target namespace must already exist for adoption. Adoption records the baseline checksum without
executing its SQL. It does not compare the live schema
with the baseline. Matching repeated adoption is harmless; conflicting history fails. A new database
instead runs `migrate` to execute the baseline normally, followed by later changes.

For a schema guard, [versioned snapshots](checking.md#schema-checkpoints) provide metadata independent
of codec/generator formatting. Keep expected references from an immutable disposable replay, and
verify functions, security and migration history separately. Never establish the expected checkpoint
from whichever live database happens to be configured. Keep old references until a replacement
is verified. Test matching adoption, refusal after drift and representative fresh-replay workflows.
