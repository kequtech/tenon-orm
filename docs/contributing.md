# Maintaining Tenon

Use Node.js 24+, npm, PostgreSQL 16+, and a compatible `pg_dump` on PATH. Keep the
committed lockfile. The public usage documentation is [agent-guide.md](../agent-guide.md)
and [adoption-guide.md](../adoption-guide.md).

```sh
npm ci
npm run check
```

`check` runs formatting, typechecking, a clean build, and the full test suite.
Use `npm run typecheck`, `npm run build`, or `npm run test:consumer` for narrower
checks. Run `npm run format` before the final check.

## Database tests

Tests require the dedicated database `tenon_orm_test`. Create it once if necessary.
The default connection is:

```sh
postgresql://postgres:postgres@localhost:5432/tenon_orm_test
```

Override its address with `TENON_TEST_DATABASE_URL`; its database name must remain
`tenon_orm_test`. The suite checks the name and server version before changes,
creates temporary namespaces, and removes them afterward. Connection-failure tests
terminate only their own test backends. Scripts do not load `.env` automatically.

CI tests PostgreSQL 16 and 18 with matching `pg_dump` clients. The consumer test
packs and installs the actual npm artifact, compiles its API with TypeScript 6
and 7, exercises application upgrades/adoption/recovery, and checks production
imports after pruning development dependencies. It uses npm's offline cache,
populated by `npm ci`. SafeQL tests use TypeScript 6 for its linting toolchain.

Test observable behavior and compiler contracts. Keep regression cases focused
on the failure they prevent. Do not preserve assertions about removed APIs.
The generated fixture and lockfile are excluded from formatting.

To regenerate the fixture, use a fresh scratch namespace in the test database:

```sh
npm run build
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tenon_orm_test
node dist/cli.js migrate --directory test/fixtures/migrations --namespace tenon_fixture
node dist/cli.js generate --namespace tenon_fixture --out test/fixtures/generated-schema.ts
```

Remove that scratch namespace afterward. Replay modified fixture migrations into
a fresh namespace; do not edit an application's applied history.

## Source and release

Public exports are in `src/index.ts`. Runtime execution lives in `client.ts`,
`connection.ts`, and `transaction.ts`. Generation and migrations each have their
own directory for catalog/SQL/file handling. `dist/` and `.test-dist/` are disposable;
build removes both before compiling. `npm run clean` removes them independently.

Before publishing, run the full checks and inspect both PostgreSQL CI results.
Review the source and `npm pack --dry-run`. The artifact includes compiled code,
declarations, README, license, and the two root usage guides; `docs/` stays in Git.
Update package version and lockfile together. Publishing is a separate, explicit
action; `prepublishOnly` runs the full suite and requires the test database.

Rehearse migration and recovery in the application's actual database/proxy
environment. The tests do not establish physical backup or PITR recovery.
`npm run benchmark` measures sequential calls on the test database, including
an artificial per-query delay; it is not a production performance guarantee.
