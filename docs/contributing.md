# Contributing

Use Node.js 24+, npm, PostgreSQL 16+, and a compatible `pg_dump` on PATH. Keep the
committed lockfile. Development uses TypeScript 6 for compatibility with SafeQL's
ESLint parser. The `typescript-next` alias checks installed consumers with TypeScript 7.
Scripts invoke compiler paths explicitly so npm's alias bin links cannot select
the wrong version.

```sh
npm ci
npm run check
```

`check` runs formatting, typechecking, a clean build, and the full test suite.
For narrower checks:

```sh
npm run format:check
npm run typecheck
npm run build
npm run test:consumer
```

Formatting, typechecking, and build need no database. `test:consumer` requires
the test database and pg_dump: it packs and installs the actual package into an isolated project, compiles positive and negative API contracts
with both compiler versions, and checks runtime imports after pruning development
dependencies. It also exercises the installed product lifecycle. It uses npm's offline cache, populated by `npm ci`.

## Test database

`npm test` requires the dedicated database `tenom_orm_test` on PostgreSQL 16 or
newer. The spelling is retained for compatibility with the existing local setup.
Tests validate its name and version before making changes. They create temporary
namespaces and remove them afterward. Connection-failure tests terminate only
backends they create in that test database.

The default connection is:

```sh
export TENON_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tenom_orm_test
npm test
```

Create that database once if it does not exist. The environment variable is only
needed to override the address; the database name must remain the same. Never point
the suite at application data. `.env.example` documents the variables, but scripts
do not load it automatically. The CLI's `DATABASE_URL` is independent. Use the application's existing
environment setup to select its target database.

CI runs Node 24 against PostgreSQL 16 and 18, using each server's own `pg_dump`.
Check the actual CI results before claiming compatibility across server majors.

## Source map

Start at `src/index.ts` for public exports. The library is small enough to read
without a framework guide:

| Files                                               | Responsibility                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/database.ts`, `src/client.ts`                  | Construction, inline/operation dispatch, and client lifetime               |
| `src/connection.ts`, `src/transaction.ts`           | Pool ownership, client error observation, and transaction cleanup          |
| `src/query.ts`                                      | Parameterized templates, identifiers, and explicit unsafe SQL              |
| `src/affected-rows.ts`                              | Affected-count validation and immutable constraints                        |
| `src/operations.ts`, `src/types.ts`                 | Operation definitions, result modes, and public type contracts             |
| `src/transaction-sql.ts`                            | Runtime transaction-boundary guard                                         |
| `src/migrations.ts`, `src/migrations/`              | Migration files, history, locking, execution, and SQL guards               |
| `src/baseline.ts`, `src/migrations/baseline-sql.ts` | Capture/adoption workflow and the pg_dump text adapter                     |
| `src/generate.ts`, `src/generation/`                | Snapshot orchestration, catalog reads, type rendering, and schema comments |
| `src/cli.ts`                                        | Command validation, routing, and atomic generated-file writes              |
| `test/`                                             | Database workflows, compiler contracts, fault cases, and packed consumers  |
| `test/fixtures/`                                    | Test schema and generated output; these are not installation migrations    |
| `config/`, `scripts/`                               | Compiler configurations and clean/build commands                           |

`dist/` and `.test-dist/` are disposable build outputs. Build removes both first,
so deleted modules cannot remain in a package. `npm run clean` removes them without
changing sources or dependencies.

## Making changes

Keep strict types and explicit errors. Prefer ordinary functions and existing
dependencies. Separate a responsibility when that makes the code easier to follow;
avoid layers that merely rename a single expression. Runtime dispatch has one
explicit cast between erased operation contracts and their typed public client.
Keep that boundary small.

Test observable database effects and function behavior. Use compiler checks for
type contracts; `test/type-contracts.ts` is compile-only and is reused against the
installed package. Avoid tests that assert CLI prose. Schema-text assertions are
appropriate when the generated artifact itself is the contract.

Run `npm run format` before the final check. The generated fixture and lockfile
are excluded from formatting because their generators own the contents.
`.gitattributes` fixes migration/fixture line endings for stable checksums.

To update the generated fixture intentionally, use a fresh scratch namespace:

```sh
npm run build
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tenom_orm_test
node dist/cli.js migrate --directory test/fixtures/migrations --namespace tenon_fixture
node dist/cli.js generate --directory test/fixtures/migrations --namespace tenon_fixture \
  --out test/fixtures/generated-schema.ts
node dist/cli.js generate --directory test/fixtures/migrations --namespace tenon_fixture \
  --out test/fixtures/generated-schema.ts --check
```

Remove only that scratch namespace afterward. If initial fixture SQL changed,
replay it in a fresh namespace; do not rewrite an application's applied history.
The integration suite independently replays and checks the committed fixture.

The existing Kequtech documentation-sync workflow and `kequtech.source` identity
are retained. Agent conversation captures are excluded from Git and npm packages.
See [release preparation](releasing.md) before distributing source or packages.
