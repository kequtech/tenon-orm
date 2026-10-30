# Shared runtime and CLI configuration

Keep connection settings and codec choices in one module used by the application and Tenon's CLI.
From the project root, create the configuration file:

```sh
npx tenon init
```

Initialization opens no database connection, imports no application code, and never overwrites a
file. Without `--config`, it refuses when a config is already discoverable in this directory or a
parent. Use `tenon init --config path.mjs` for an explicit additional destination or JavaScript output. The generated TypeScript config looks like this:

```ts
import type { TenonConfig } from '@kequtech/tenon-orm';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

export default {
  connection: {
    connectionString,
  },
  migrations: { directory: 'migrations', namespace: 'public' },
  generate: { out: 'src/generated-schema.d.ts' },
  check: { project: 'tsconfig.json' },
} satisfies TenonConfig;
```

Add the application's registry as `connection.codecs` when choosing custom representations.

`TenonConfig` and `ConnectionConfig` are exported TypeScript types; configuration is a plain
default-exported object. Use that connection when constructing the application instance:

```ts
// src/db.ts
import { createTenon } from '@kequtech/tenon-orm';
import config from '../tenon.config.ts';

export const db = createTenon({ connection: config.connection });
```

The `.ts` imports above run directly with Node.js 24+ TypeScript support. For typechecking with
`noEmit`, enable `allowImportingTsExtensions`; emitting projects can use
`rewriteRelativeImportExtensions`. Config and its runtime imports must be runnable by Node without
bundler aliases or transformations. ESM JavaScript is also supported.

Export configuration values, not an open pool, database instance, or factory. Importing the config
must not start the server, open listeners, or depend on generated runtime files. Tenon opens and
closes its own tooling resources. `createTenon` still accepts application-owned pools separately.

## Run commands

```sh
npx tenon new create_users
npx tenon migrate
npx tenon generate
npx tenon generate --check
npx tenon check
npx tenon check src/users.ts:23 --json
npx tenon describe query.sql
```

`generate`, `check`, and `describe` require configuration. They use its connection and codec registry
and never fall back to `DATABASE_URL` merely because a config is missing or invalid. Your config
chooses which environment variables to read; Tenon does not load `.env` files automatically.

`new`, migration/status/rollback, and baseline commands also discover configuration. Without a
config, they retain the existing migration-directory defaults and `DATABASE_URL` connection
workflow. `init`, `new`, and `--help` open no database connection. Config imports may still require environment
values, according to the module you wrote. Invalid session/timeout settings are rejected when config
loads, even for commands that do not inspect queries. Migration SQL and history reads use default decoding;
application codec overrides do not change migration bookkeeping.

## Discovery, paths, and overrides

Tenon searches the working directory and then parents for the nearest directory containing
`tenon.config.ts`, `.mts`, `.js`, or `.mjs`. Multiple recognized files in that directory are an error.
Select one explicitly when needed:

```sh
npx tenon generate --config config/tenon.production.mts --check
```

`--config` resolves from the working directory. An explicit missing file or an import failure is an
error; Tenon never switches to another configuration after that failure.

Paths stored in config resolve from the config file's directory. Configured migration directories,
generation output, and checker projects therefore work when a command runs from a nested directory.
An omitted migration directory means `migrations` beside the config; an omitted checker project
means `tsconfig.json` beside it. Relative CLI path arguments and flags resolve from the working
directory. CLI flags override the corresponding configured values.

## Configuration fields

| Field                  | Purpose                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`           | Required PostgreSQL URI or pgclear pool-option values, including TLS, password callbacks, startup parameters, and codecs. Open pools are rejected.          |
| `migrations.directory` | Migration files; defaults to `migrations` relative to config.                                                                                               |
| `migrations.namespace` | Migration/history schema; defaults to `public`. Also supplies the generation namespace when generation does not specify one.                                |
| `generate.out`         | Required when a `generate` section is present. Otherwise supply `--out` to the generation command.                                                          |
| `generate.namespace`   | Schema to generate; overrides the migration namespace for generation only.                                                                                  |
| `baseline.schemas`     | Optional nonempty list of schemas for native baseline capture. Omission captures the whole database, independently of the migration namespace.              |
| `baseline.connection`  | Optional native libpq connection for baseline capture; `--connection` overrides it.                                                                         |
| `check.project`        | TypeScript project; defaults to `tsconfig.json` relative to config.                                                                                         |
| `check.readTypes`      | Explicit type expressions for custom decoders whose representations are unidentified. See [checking](query-checking.md#programmatic-use-and-custom-codecs). |
| `session`              | Optional inspection/checking `role`, `searchPath`, and `timeZone` overrides. They do not configure runtime queries or migrations.                           |
| `timeouts`             | Optional inspection/checking `connectMs`, `statementMs`, and `lockMs` bounds.                                                                               |

Generation and runtime queries use `connection.codecs`. Checking and inspection inherit that registry
too. Their internal catalog queries keep default decoding. Runtime startup parameters are retained,
with inspection's statement/lock timeout bounds applied regardless of startup-parameter casing; explicit `session` settings and CLI flags
then override role, search path, or timezone for inspection. See [connections](connections.md) and
[inspection limits](query-inspection.md#session-and-timeouts).

Keep credentials and deployment-specific addresses in environment variables or the existing secret
provider. For a migration role different from the application role, select a separate config that
imports shared settings and supplies that role's connection. Avoid duplicating codec definitions.

Baseline capture uses native `pg_dump`, which accepts a libpq connection string rather than pgclear
option objects or password callbacks. Configure its native connection and scope explicitly when
needed:

```ts
// Additional fields in the shared config:
baseline: { connection: connectionString, schemas: ['public'] }
```

Capture uses `--connection`, then `baseline.connection`, then a string main connection or the
no-config `DATABASE_URL` fallback. `--schema` flags replace `baseline.schemas`. Adoption ignores
capture-only settings. Supply the same database and required native TLS/authentication settings;
Tenon does not translate driver-specific settings into libpq settings.

## Programmatic APIs

The CLI owns generated-file output and freshness checks. `generateDefinitions` returns source text
without file handling for callers building custom tooling; it accepts explicit connection/options.

`describeQuery` and `checkQueries` accept a URI or connection-option values and inherit
`connection.codecs`. An explicit `codecs` argument selects the read mappings reported by those
inspection APIs. They own separate, short-lived sessions and do not join callback transactions.
Migration APIs continue accepting explicit connection/options. No programmatic API discovers config.

The CLI imports the selected trusted config and its dependencies. Source checking subsequently reads
query source without importing those query modules or executing application SQL. TypeScript loads
only for source checking, not for normal queries, migrations, generation, or inspection.
