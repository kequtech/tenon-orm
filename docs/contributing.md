# Development

Use Node.js 24+, npm, PostgreSQL 16+ and a compatible `pg_dump` on PATH. Keep the
committed lockfile. Repository development uses TypeScript 7; a separate compiler
alias verifies the consumer minimum of 5.7.2. npm scripts invoke the intended
compiler explicitly, avoiding alias binary-link ambiguity.

```sh
npm ci
npm run format:check
npm run typecheck
npm run build
npm run test:consumer
npm test
# Or run all required validation:
npm run check
```

`typecheck` and `build` need no database or generation. `test:consumer` packs and
installs the real package in an isolated project using npm's offline dependency
cache, populated by `npm ci`. It checks package contents, license, installed CLI,
both consumer compilers, production runtime imports and caller-owned pool
behavior after pruning development typings.

`npm test` first checks that the selected database is named `tenom_orm_test` and
runs PostgreSQL 16 or newer. Tests create isolated namespaces and remove their
own namespaces. Use a dedicated test database, never an application database.
The existing local convention is `postgres:postgres` on localhost. Set
`TENON_TEST_DATABASE_URL` to override its address while retaining the test name:

```sh
export TENON_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tenom_orm_test
npm test
```

The default connection is the same URL, so an existing local setup needs no new
credentials. Create that test database once if it does not exist. `.env.example`
documents the variables; npm scripts do not automatically load it. The CLI reads
`DATABASE_URL`, independently of the test connection.

## Repository map

| Path                        | Responsibility                                                      |
| --------------------------- | ------------------------------------------------------------------- |
| `src/`                      | Runtime SQL API, migrations, generation and CLI                     |
| `test/`                     | Behavioral and compiler contracts, committed generated fixture      |
| `test/fixtures/migrations/` | Test schema; not migrations for installing Tenon                    |
| `config/`                   | Build and test compiler configurations                              |
| `scripts/`                  | Small repository maintenance commands                               |
| `docs/`                     | Design decisions, unfinished work, development and release guidance |
| `.github/workflows/`        | CI and the existing Kequtech documentation sync                     |
| `dist/`, `.test-dist/`      | Disposable build outputs, ignored by Git                            |

## Read the source

Start at `src/index.ts` for the public exports and `src/database.ts` for connection
ownership and client construction. Each layer has a concrete responsibility:

| Path                                      | Responsibility                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `src/client.ts`                           | Shared inline/named dispatch and result handling                            |
| `src/operations.ts`, `src/types.ts`       | Operation definitions and public type contracts                             |
| `src/connection.ts`, `src/transaction.ts` | Pool ownership, statement execution and callback lifetime                   |
| `src/migrations.ts`                       | Migration status and forward/reverse execution                              |
| `src/migrations/`                         | File format, checksums, stored history, advisory-lock cleanup and SQL guard |
| `src/generate.ts`                         | One read-only snapshot and generated artifact assembly                      |
| `src/generation/`                         | Catalog reads, driver type mappings and descriptive schema comments         |
| `src/baseline.ts`                         | Native pg_dump capture/adaptation and explicit adoption                     |
| `src/cli.ts`                              | Command routing, warnings and atomic generated-file writes                  |

The runtime transaction guard reads only a statement prefix. The migration guard
scans complete files while skipping quoted strings and bodies. They deliberately
remain separate: neither is a general SQL parser. The client retains one explicit
cast where runtime dispatch meets each definition's compile-time input/output
contract; keep that boundary small instead of spreading assertions through the API.

Tests are grouped by execution, operations, transactions, migration files/history,
CLI, generation values/domains, schema comments and packed consumers. Shared test
helpers own temporary migration projects, database safety checks and real consumer
compilation. Fixtures contain data/contracts, not runtime framework code. Assert
observable database effects and type behavior; avoid tying workflow tests to CLI
prose. Schema-text assertions remain appropriate for the generated schema artifact.
`test/type-contracts.ts` is compile-only and is reused by the packed consumer;
keep it separate from executable `*.test.ts` cases.

## Formatting and checks

The root TypeScript configuration enables strict checking. `.editorconfig`
defines whitespace conventions; `.gitattributes` fixes SQL and generated-fixture
line endings so checksums and freshness checks survive platform changes. Prefer
native language features and existing dependencies. Keep APIs and configuration
small and responsibilities separate. Preserve the SQL-first design.

`npm run format` applies Prettier to source, tests, documentation and configuration;
`npm run format:check` checks it without writing. The generated schema fixture and
lockfile are excluded: their generators own their contents. `npm run check` runs
formatting checks, typechecking and the complete test suite. Production builds also
reject unused locals and parameters. Use braces for control flow and explicit type
imports; introduce an abstraction when it owns a responsibility or removes real
duplication, rather than hiding a single expression behind another name.

Build cleans both compiler output directories before emitting JavaScript and
public declarations, so deleted source modules cannot linger in a tarball. It
also marks the emitted CLI executable for direct use and package distribution.
`npm run clean` removes those outputs without touching sources or dependencies.

## Change the schema fixture

The integration suite replays the fixture into a fresh namespace and verifies
`test/fixtures/generated-schema.ts`, including its schema comments and history. To update
that artifact intentionally, use the test database and a separate scratch
namespace:

```sh
npm run build
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tenom_orm_test
node dist/cli.js migrate --directory test/fixtures/migrations --namespace tenon_fixture
node dist/cli.js generate --directory test/fixtures/migrations --namespace tenon_fixture \
  --out test/fixtures/generated-schema.ts
node dist/cli.js generate --directory test/fixtures/migrations --namespace tenon_fixture \
  --out test/fixtures/generated-schema.ts --check
```

Remove only that scratch namespace after use. If you intentionally rewrite the
test fixture's initial SQL, replay it in a fresh namespace; do not rewrite an
application's applied migration history. Tests generate their own temporary
schema names and clean them up.

## CI and release boundaries

CI is configured for Node 24 against PostgreSQL 16 and 18. It uses each server
container's `pg_dump`, checks types and real PostgreSQL workflows, tests the
packed consumer, and previews package contents. A configured matrix is not a
passing run; check actual results before claiming cross-version verification.
All 81 runtime tests pass locally on PostgreSQL 16.15, including the minimum and development
consumer compilers. Simulated commit, rollback, advisory-unlock and pool-shutdown
failures check error preservation and connection disposal. These cases do not
establish production resilience to every live connection-loss scenario.

The existing Kequtech documentation synchronization workflow is preserved.
`kequtech.source` remains `tenon-orm`; npm's organization scope does not change
that editorial identity. Repository-local conversation recording is disabled;
agent capture files are ignored and excluded from npm packages.

See [releasing.md](releasing.md) before any public repository or npm release.
