# Development

Use Node.js 24+, npm, PostgreSQL 16+ and a compatible `pg_dump` on PATH. Keep the
committed lockfile. Repository development uses TypeScript 7; a separate compiler
alias verifies the consumer minimum of 5.7.2. npm scripts invoke the intended
compiler explicitly, avoiding alias binary-link ambiguity.

```sh
npm ci
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

| Path | Responsibility |
| --- | --- |
| `src/` | Runtime SQL API, migrations, generation and CLI |
| `test/` | Behavioral and compiler contracts, committed generated fixture |
| `test/fixtures/migrations/` | Test schema; not migrations for installing Tenon |
| `config/` | Build and test compiler configurations |
| `scripts/` | Small repository maintenance commands |
| `docs/` | Design decisions, unfinished work, development and release guidance |
| `.github/workflows/` | CI and the existing Kequtech documentation sync |
| `dist/`, `.test-dist/` | Disposable build outputs, ignored by Git |

The root TypeScript configuration enables strict checking. `.editorconfig`
defines whitespace conventions; `.gitattributes` fixes SQL and generated-fixture
line endings so checksums and freshness checks survive platform changes. Prefer
native language features and existing dependencies. Keep APIs and configuration
small and responsibilities separate. Preserve the SQL-first design.

Build cleans both compiler output directories before emitting JavaScript and
public declarations, so deleted source modules cannot linger in a tarball. It
also marks the emitted CLI executable for direct use and package distribution.
`npm run clean` removes those outputs without touching sources or dependencies.

## Change the schema fixture

The integration suite replays the fixture into a fresh namespace and verifies
`test/generated-schema.ts`, including its schema comments and history. To update
that artifact intentionally, use the test database and a separate scratch
namespace:

```sh
npm run build
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tenom_orm_test
node dist/cli.js migrate --directory test/fixtures/migrations --namespace tenon_fixture
node dist/cli.js generate --directory test/fixtures/migrations --namespace tenon_fixture \
  --out test/generated-schema.ts
node dist/cli.js generate --directory test/fixtures/migrations --namespace tenon_fixture \
  --out test/generated-schema.ts --check
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
The baseline suite has been exercised locally on PostgreSQL 16.15.

The existing Kequtech documentation synchronization workflow is preserved.
`kequtech.source` remains `tenon-orm`; npm's organization scope does not change
that editorial identity. Repository-local conversation recording is disabled;
agent capture files are ignored and excluded from npm packages.

See [releasing.md](releasing.md) before any public repository or npm release.
