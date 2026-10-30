# Shared runtime and CLI configuration

A `TenonConfig` describes one database: its connection, codecs, runtime query observer, and CLI
defaults. The application and CLI use the same object, so generated types and query checks follow
the representations returned at runtime.

Create the configuration from the project root:

```sh
npx tenon init
```

The command writes `tenon.config.ts` with a named `main` export:

```ts
import type { TenonConfig } from '@kequtech/tenon-orm';

export const main = {
  connection: { connectionString: process.env.DATABASE_URL },
  migrations: { directory: 'migrations', namespace: 'public' },
  generate: { out: 'src/generated-schema.d.ts' },
  check: { project: 'tsconfig.json' },
} satisfies TenonConfig;
```

Add `connection.codecs` when choosing custom representations. Initialization needs no credentials,
imports no application code, and never overwrites a file. It refuses to create a default config when
one is already discoverable in the current directory or a parent. Use `--config path.mjs` for an
explicit destination or JavaScript output.

Import the config into the application and pass it directly to `createTenon`:

```ts
// src/db.ts
import { createTenon } from '@kequtech/tenon-orm';
import { main } from '../tenon.config.ts';

export const db = createTenon(main);
```

## Initialization and imports

Constructing `db` checks the config's shape without validating credentials or creating a pool. The
first query or transaction initializes one pool, which subsequent and concurrent calls reuse.
Accessing `db.native` also initializes the pool and validates its settings; the driver connects when
an operation needs a session. Closing an unused instance creates no pool and needs no credentials.

Read environment values in the config without a top-level credential check. This lets builds import
application modules without database access. An undefined or empty `connection`, or an explicitly
undefined or empty `connectionString`, fails when the database is used and never selects the driver's
localhost defaults. Environment values are captured when the module is imported, so supply runtime
variables before starting the application. Queries performed during a build still need credentials.

The `.ts` imports above run with Node.js 24+ TypeScript support. For typechecking with `noEmit`, enable
`allowImportingTsExtensions`; emitting projects can use `rewriteRelativeImportExtensions`. Config
files and their imports must run in Node without bundler aliases or transformations. ESM JavaScript
is also supported.

Keep config files free of resource initialization: export connection values and codecs, and let Tenon
open and close its tooling resources. The application reuses its database instance and closes it at
shutdown. Programmatic configs can also borrow an existing pool; see [pool ownership](connections.md#use-an-application-owned-pool).

## Multiple databases

Export one config per database from the same file. For example, add `analytics` beside `main` in
`tenon.config.ts`:

```ts
export const analytics = {
  connection: { connectionString: process.env.ANALYTICS_DATABASE_URL },
  migrations: { directory: 'analytics/migrations', namespace: 'public' },
  generate: { out: 'src/analytics-schema.d.ts' },
  check: { project: 'tsconfig.json' },
} satisfies TenonConfig;
```

Each export has its own connection settings and codecs. Use the same `connection.codecs` value when
databases share a registry, and give each database its own migrations and generated output.
Application code selects the export through an ordinary import:

```ts
import { createTenon } from '@kequtech/tenon-orm';
import { main, analytics } from '../tenon.config.ts';

export const db = createTenon(main);
export const analyticsDb = createTenon(analytics);
```

The CLI selects the corresponding export with `--database`:

```sh
npx tenon migrate --database main
npx tenon migrate --database analytics
npx tenon generate --database analytics
npx tenon check src/analytics/queries.ts --database analytics
npx tenon new add_events --database analytics
```

A file with one config is selected automatically. Multiple database exports require `--database`;
an unknown name fails without selecting another connection. Named objects with a `connection` field
are database configs, while other helper exports are ignored. Existing default exports remain
supported and can be selected explicitly as `--database default`.

Only the selected config's settings are validated, although importing the file evaluates the whole
module. Keep credentials as plain environment reads so one database does not require another's
credentials. Runtime selection uses the imported object and does not depend on the working directory.
Close each instance separately. For databases with different schemas, use separate checker projects
or select the relevant query file when running `tenon check`.

`--config` selects a file and `--database` selects an export within it. For example,
`tenon init --config config/tenon.production.ts` creates another file, and
`tenon migrate --config config/tenon.production.ts --database main` selects its `main` export.

## Run commands

With the single config generated by `tenon init`:

```sh
npx tenon new create_users
npx tenon migrate
npx tenon generate
npx tenon generate --check
npx tenon check
npx tenon check src/users.ts:23 --json
npx tenon describe query.sql
```

Generation, checking, and inspection require configuration and use its connection and codecs. A
missing or invalid config fails instead of falling back to `DATABASE_URL`. The config chooses which
environment variables to read; Tenon does not load `.env` files.

Migration creation, migration/status/rollback, and baseline commands also discover configuration.
Without a config or an explicit `--database`, they retain the migration-directory defaults and
`DATABASE_URL` workflow. `init`, `new`, and `--help` need no database credentials. `new` reads migration
settings without validating the connection; `--help` loads no config. Any eager checks in your own
config module still run when that module is imported.

The CLI validates the selected config's tooling sections when loading it, including session and
timeout settings for commands that do not inspect queries. Migration SQL and history reads use
default decoding, independently of application codec overrides.

## Discovery, paths, and overrides

Tenon searches the working directory and then its parents for the nearest directory containing
`tenon.config.ts`, `.mts`, `.js`, or `.mjs`. Multiple recognized files in that directory require an
explicit selection:

```sh
npx tenon generate --config config/tenon.production.mts --check
```

`--config` resolves from the working directory. A missing file, missing database export, or import
failure is an error; Tenon does not switch to another configuration after a failure.

Configured paths resolve from the config file's directory. An omitted migration directory means
`migrations` beside the config, and an omitted checker project means `tsconfig.json` beside it. CLI
path flags resolve from the working directory and override the corresponding configured values.

## Configuration fields

| Field                  | Purpose                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`           | PostgreSQL URI or pgclear pool options, including TLS, password callbacks, startup parameters, and codecs. Required when the database is used.  |
| `onQuery`              | Optional observer for completed runtime queries. CLI tooling and native calls do not invoke it.                                                 |
| `migrations.directory` | Migration files; defaults to `migrations` beside the config.                                                                                    |
| `migrations.namespace` | Migration/history schema; defaults to `public`. Also supplies the generation namespace unless overridden.                                       |
| `generate.out`         | Required when `generate` is present. Otherwise supply `--out`.                                                                                  |
| `generate.namespace`   | Schema to generate; overrides the migration namespace for generation.                                                                           |
| `baseline.schemas`     | Optional nonempty schema list for native baseline capture. Omission captures the whole database.                                                |
| `baseline.connection`  | Optional native libpq connection for baseline capture; `--connection` overrides it.                                                             |
| `check.project`        | TypeScript project; defaults to `tsconfig.json` beside the config.                                                                              |
| `check.readTypes`      | Fallback type expressions for unidentified decoder representations. See [query checking](query-checking.md#programmatic-use-and-custom-codecs). |
| `session`              | Inspection/checking overrides for `role`, `searchPath`, and `timeZone`.                                                                         |
| `timeouts`             | Inspection/checking bounds for `connectMs`, `statementMs`, and `lockMs`.                                                                        |

Generation, checking, and inspection inherit `connection.codecs`; their internal catalog queries
keep default decoding. Runtime startup parameters are retained. Inspection applies its statement
and lock timeout bounds regardless of startup-parameter casing, then applies explicit session and
CLI overrides. These inspection settings do not change runtime queries or migrations. See
[connection settings](connections.md) and [inspection limits](query-inspection.md#session-and-timeouts).

Keep credentials and deployment addresses in environment variables or the existing secret provider.
For a separate migration role, add a config export with that role's connection and the shared codecs.

## Native baseline capture

Baseline capture uses `pg_dump`, which requires a native libpq connection string. If the main
connection uses a driver-options object, add the native URI to the config:

```ts
// Within the database config:
baseline: { connection: process.env.DATABASE_URL, schemas: ['public'] }
```

Capture uses `--connection`, then `baseline.connection`, then a string main connection or the
no-config `DATABASE_URL` fallback. `--schema` flags replace `baseline.schemas`. Adoption ignores
capture-only settings. Supply the same database and its required native TLS/authentication settings;
Tenon does not translate driver options into libpq settings.

## Programmatic APIs

`createTenon(config)` accepts the shared object and initializes its connection lazily. Other
programmatic APIs take explicit connection and operation options; none discover config files.

The CLI owns generated-file output and freshness checks. `generateDefinitions` returns source text
for custom tooling without writing files. `describeQuery` and `checkQueries` inherit codecs from
connection-option values; an explicit `codecs` argument selects their reported read mappings. These
inspection APIs own separate, short-lived sessions and do not join callback transactions.

The CLI imports the selected trusted config and its dependencies. Source checking then reads query
modules without importing them or executing their SQL. TypeScript loads only for source checking.
