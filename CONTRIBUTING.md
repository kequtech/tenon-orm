# Maintaining Tenon

Use Node.js 24+, npm, PostgreSQL 16+, and compatible `pg_dump` client tools on PATH. Keep the
committed lockfile. Public usage starts at the [README](README.md); the complete `docs/` folder and
[Changelog](CHANGELOG.md) ship with the package. This maintainer guide and
[driver considerations](CONSIDERATIONS.md) stay in the repository.

```sh
npm ci
npm run check
```

`check` runs formatting, typechecking, a clean build, and the full test suite. Narrower checks are
`npm run typecheck`, `npm run build`, `npm run test:consumer`, and `npm run test:describe`.
`npm run format` applies formatting; the generated fixture and lockfile are excluded.

## Database tests

Create the dedicated `tenon_orm_test` database once if necessary. The default connection is:

```text
postgresql://postgres:postgres@localhost:5432/tenon_orm_test
```

Override the address with `TENON_TEST_DATABASE_URL`; the database name must remain
`tenon_orm_test`. Tests check its name/server version before changes and use temporary namespaces.
Some tests also create temporary roles, so the connection needs permission to create them.
Connection-failure tests terminate their own backends. Fixtures suppress routine PostgreSQL notices
but retain warnings/errors. Scripts do not load `.env` automatically.

CI uses PostgreSQL 16 and 18 with matching `pg_dump` clients. Packed-consumer tests install the
actual artifact, compile public/generated types with TypeScript 6 and 7, and exercise the API and
CLI without development dependencies. They prefer npm's cache and fetch missing packages/metadata.
The suite is self-contained and requires no application checkout or third-party ORM installation.

Test observable behavior and compiler contracts. Include focused regressions for bugs; avoid tests
that depend on prose wording. For documentation examples, verify the assumed schema, imports,
input/output types, and execution behavior against the implementation. Keep relative consumer links
within the package; use repository URLs for maintainer-only material.

To regenerate the committed fixture, first ensure `tenon_fixture` is an unused scratch namespace:

```sh
npm run build
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tenon_orm_test
node dist/cli.js migrate --directory test/fixtures/migrations --namespace tenon_fixture
node dist/cli.js generate --namespace tenon_fixture --out test/fixtures/generated-schema.ts
```

Remove the scratch namespace afterward. Replay changed fixture migrations into a fresh namespace;
do not edit an application's applied history.

## Source layout

Public exports are in `src/index.ts`. `query.ts` compiles detached SQL/fragments; `mutations.ts`
builds object-write fragments. `client.ts` validates calls and reads results; `transaction.ts` owns
callback boundaries and guarded-write savepoints. `connection.ts` constructs clients and binds SQL.

Driver-specific behavior is isolated in `src/driver/`: array NULL parsing, type mappings, connection
observation, reservations, and native LISTEN shutdown. Keep the driver pinned and follow
[CONSIDERATIONS.md](CONSIDERATIONS.md) before an upgrade.

Generation, migrations, and inspection separate catalog/SQL work from file output and CLI handling.
The CLI dispatches these operations. `dist/` and `.test-dist/` are disposable; build removes both
before compiling, and `npm run clean` removes them independently.

## Release checks

Run the full checks and inspect both PostgreSQL CI results, the source diff, and `npm pack --dry-run`.
The artifact includes compiled code/declarations, README, license, the consumer guides, and changelog.
The consumer test checks relative documentation targets in the installed package.

Keep changelog entries concise: describe consumer-visible changes and required upgrade actions.
The bundled changelog is the version history for agents upgrading projects; driver investigations
belong in `CONSIDERATIONS.md`. Update package version and lockfile together before release.
Publishing requires an explicit request; `prepublishOnly` runs the full checks and needs the test
database. The package is `@kequtech/tenon-orm`; preserve the configured Git remote.

`npm run benchmark` measures local sequential queries, complete transactions, guarded writes, and
batching on a warm single-connection pool. SQL dispatch counts are not protocol round-trip counts.
Local tests and timings do not establish production throughput or backup/PITR recovery; rehearse
changes in the intended deployment environment.
