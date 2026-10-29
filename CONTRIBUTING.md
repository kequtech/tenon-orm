# Maintaining Tenon

Use Node.js 24+, npm, PostgreSQL 16+, and compatible `pg_dump` client tools on PATH. Keep the
committed lockfile. Public usage starts at the [README](README.md); the complete `docs/` folder and
[Changelog](CHANGELOG.md) ship with the package. This maintainer guide and
[driver considerations](CONSIDERATIONS.md) stay in the repository.
Historical investigations and superseded proposals belong in `notes/`, which is excluded from the
package. See the [archived Pgclear review](notes/pgclear-author-feedback-2026-10-28.md) for the
original adoption investigation; current contracts belong in the consumer reference.
The [codec integration brief](notes/tenon-pgclear-integration-brief.md) records the agreed
Pgclear/Tenon boundary and dependency release checks.

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

Override the address with `TENON_TEST_DATABASE_URL`; the database name must remain `tenon_orm_test`.
Tests check its name/server version before changes and use temporary namespaces. Some tests also
create temporary roles, so the connection needs permission to create them. Connection-failure tests
terminate their own backends. Scripts do not load `.env` automatically.

CI uses PostgreSQL 16 and 18 with matching `pg_dump` clients. Packed-consumer tests install the
actual artifact, compile public/generated types with TypeScript 6 and 7, and exercise the API and
CLI without development dependencies. They prefer npm's cache and fetch missing packages/metadata.
The suite is self-contained and requires no application checkout or third-party ORM installation.

For an unpublished Pgclear candidate, install its fresh tarball without changing the dependency
lock, then pass that same artifact to packed-consumer tests explicitly:

```sh
npm install --no-save --package-lock=false --ignore-scripts /absolute/path/pgclear-candidate.tgz
TENON_TEST_PGCLEAR_TARBALL=/absolute/path/pgclear-candidate.tgz npm run check
```

Packed-consumer candidate tests explicitly override Tenon's transitive driver dependency as well.
Ordinary checks resolve the declared registry dependency. Candidate checks do not establish that a
published dependency is available; finalize the semver dependency and lockfile against the actual
published release before publishing Tenon. Keep local tarball paths out of release dependencies.

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

Remove the scratch namespace afterward. Replay changed fixture migrations into a fresh namespace; do
not edit an application's applied history.

## Source layout

Public exports are in `src/index.ts`. `query.ts` compiles detached SQL/fragments; `mutations.ts`
builds object-write fragments. `client.ts` validates calls and reads results; `transaction.ts` owns
callback boundaries and guarded-write savepoints. `connection.ts` owns pool lifetime and binds SQL.
pgclear owns execution, recovery, Describe, and codec representation metadata. Tenon owns schema
catalog queries, defaults/domains/identities, schema summaries, declaration rendering, and source
checking. Use the public driver API and the 0.3.x runtime dependency; follow
[CONSIDERATIONS.md](CONSIDERATIONS.md) when changing that boundary.

Generation, migrations, and inspection separate catalog/SQL work from file output and CLI handling.
The CLI dispatches these operations. Source checking lives in src/check/: project context and
symbol resolution, bounded composition recovery, contract comparison, and structured reports.
TypeScript is a runtime tooling dependency, loaded only through the check command or check subpath.
`dist/` and `.test-dist/` are disposable; build removes both before compiling, and `npm run clean`
removes them independently.

## Release checks

Run the full checks and inspect both PostgreSQL CI results, the source diff, and
`npm pack --dry-run`. The artifact includes compiled code/declarations, README, license, the
consumer guides, and changelog. The consumer test checks relative documentation targets in the
installed package.

From a clean registry installation (`npm ci`), run `npm publish --dry-run` against the dedicated test
database before publishing. This exercises `prepublishOnly` (the full checks) and `prepack` (the
clean build), then lists the actual package contents without publishing. The final build removes
`.test-dist/`; that is expected. Verify the manifest and lockfile agree on the release version and
that the driver resolves to a published registry release, without a candidate tarball override.

Keep changelog entries concise: describe consumer-visible changes and required upgrade actions. The
bundled changelog is the version history for agents upgrading projects; driver investigations belong
in `CONSIDERATIONS.md`. Update package version and lockfile together before release. Publishing
requires an explicit request; `prepublishOnly` runs the full checks and needs the test database. The
package is `@kequtech/tenon-orm`; preserve the configured Git remote.

`npm run benchmark` measures local sequential queries, complete transactions, guarded writes, and
batching on a warm single-connection pool. Local timings do not establish production throughput.
