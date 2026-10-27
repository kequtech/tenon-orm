# Maintaining Tenon

Use Node.js 24+, npm, PostgreSQL 16+, and a compatible `pg_dump` on PATH. Keep the committed
lockfile. The public usage documentation is [human-guide.md](docs/human-guide.md),
[agent-guide.md](docs/agent-guide.md), [reference.md](docs/reference.md), and
[adoption-guide.md](docs/adoption-guide.md).

```sh
npm ci
npm run check
```

`check` runs formatting, typechecking, a clean build, and the full test suite. Use
`npm run typecheck`, `npm run build`, or `npm run test:consumer` for narrower checks. Run
`npm run format` before the final check.

Run `npm run test:describe` for focused query-inspection and timeout tests. After building, use
`node dist/cli.js describe test/pilots/query.sql` with `DATABASE_URL` to inspect a SQL file.
The [Mail/Identity pilots](test/pilots/README.md) run separately against application source through
`npm run test:pilots -- --applications /path/to/monorepo`.

## Database tests

Tests require the dedicated database `tenon_orm_test`. Create it once if necessary. The default
connection is:

```sh
postgresql://postgres:postgres@localhost:5432/tenon_orm_test
```

Override its address with `TENON_TEST_DATABASE_URL`; its database name must remain `tenon_orm_test`.
The suite checks the name and server version before changes, creates temporary namespaces, and
removes them afterward. Test connections use `client_min_messages=warning` to suppress routine
fixture notices while retaining PostgreSQL warnings and errors. Connection-failure tests terminate
only their own test backends. Scripts do not load `.env` automatically.

Inspection context and baseline security tests also create and remove temporary roles. The test connection
needs permission to create those roles; the configured local and CI postgres user has it.

CI tests PostgreSQL 16 and 18 with matching `pg_dump` clients. The consumer test packs and installs
the actual npm artifact, compiles its API with TypeScript 6 and 7, exercises application
upgrades/adoption/recovery, and checks production imports in a fresh production-only installation.
It prefers npm's cache and downloads missing dependencies or metadata. Inspection tests compare
database metadata with actual query results, cover dynamic composition, and verify session settings,
timeouts, and resource cleanup. Generated row and mutation input types are compiled against both
supported TypeScript versions. Production API and CLI checks run without development dependencies.

Test observable behavior and compiler contracts. Keep regression cases focused on the failure they
prevent. Do not preserve assertions about removed APIs. The generated fixture and lockfile are
excluded from formatting.

To regenerate the fixture, use a fresh scratch namespace in the test database:

```sh
npm run build
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tenon_orm_test
node dist/cli.js migrate --directory test/fixtures/migrations --namespace tenon_fixture
node dist/cli.js generate --namespace tenon_fixture --out test/fixtures/generated-schema.ts
```

Remove that scratch namespace afterward. Replay modified fixture migrations into a fresh namespace;
do not edit an application's applied history.

## Source and release

Public exports are in `src/index.ts`. `query.ts` compiles detached SQL and fragments;
`mutations.ts` builds object-based write fragments. `client.ts` handles public query options and
results; `transaction.ts` owns callback boundaries and guarded-write savepoints.

`connection.ts` creates clients and binds compiled queries. Driver-specific behavior is contained
in `driver/`: `array.ts` installs SQL NULL array parsing, `types.ts` supplies shared type mappings,
`lifecycle.ts` observes connection closures, `session.ts` reserves and releases guarded sessions,
and `listener.ts` prevents owned native LISTEN reconnects after shutdown.
Keep the `postgres` dependency pinned. [CONSIDERATIONS.md](CONSIDERATIONS.md) records driver
workarounds, upstream issues, and the behavior to verify before an upgrade.

Generation and migrations have separate catalog, file, and SQL modules. `generation/output.ts`
handles writing and checking generated files. Public query inspection starts in `describe.ts`;
`inspection/` separates input validation, session limits, catalog reads, report formatting, and CLI
flags. The CLI dispatches these operations without implementing their database behavior.

`dist/` and `.test-dist/` are disposable; build removes both before compiling. `npm run clean`
removes them independently.

Before publishing, run the full checks and inspect both PostgreSQL CI results. Review the source and
`npm pack --dry-run`. The artifact includes compiled code, declarations, README, license, and the
complete `docs/` folder. This contributing guide stays in the repository and is excluded from the
npm artifact. Keep the root `CHANGELOG.md` current and included in the npm package. Update package
version and lockfile together. Publishing is a separate, explicit
action; `prepublishOnly` runs the full suite and requires the test database.

The npm package is `@kequtech/tenon-orm`; the Git repository is
`git@github.com:kequtech/tenon-orm.git`. Entire CLI is not required for development, CI, or publishing.

Rehearse migration and recovery in the application's actual database/proxy environment. The tests do
not establish physical backup or PITR recovery. `npm run benchmark` measures sequential calls on the
test database, including complete transactions with reservation, bootstrap, BEGIN, and COMMIT.
It compares prepared/unprepared native queries, Tenon queries, guarded writes, and separate versus
batched inserts on a warm single-connection pool. SQL dispatch counts are not protocol round-trip
counts, and local timings are not a production performance guarantee.
