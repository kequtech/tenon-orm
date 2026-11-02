# Maintaining Tenon

Use Node.js 24+, npm, PostgreSQL 16+, and compatible `pg_dump` client tools on PATH. Keep the
committed lockfile and configured Git remote.

```sh
npm ci
npm run check
```

`check` runs formatting, typechecking, a clean build, and the full test suite. Focused commands are
`npm run typecheck`, `npm run build`, `npm run test:consumer`, and `npm run test:describe`.
`npm run format` applies formatting. The committed generated fixture and lockfile are excluded.

## Test database

Tests require the dedicated `tenon_orm_test` database, defaulting to:

```text
postgresql://postgres:postgres@localhost:5432/tenon_orm_test
```

Create it once if necessary. `TENON_TEST_DATABASE_URL` can override the address, but the database
name must remain `tenon_orm_test`. Tests check its name and server version before changing temporary
namespaces. Jobs integration tests create and remove a temporary database on the same server to
isolate their fixed `pgclear_jobs` schema, preserving any storage in `tenon_orm_test`. The test role
therefore needs `CREATEDB`. Some tests need permission to create roles; connection-failure tests terminate their
own backends. Scripts do not load `.env` automatically.

CI runs PostgreSQL 16 and 18 with matching `pg_dump` clients. Packed-consumer tests install the actual
artifact and compile public/generated types with TypeScript 6 and 7, without repository development
dependencies. They prefer npm's cache and fetch missing packages/metadata. No application checkout
or third-party ORM installation is required.

Test observable workflows, function behavior, and compiler contracts. Add focused regressions for
bugs. Avoid tests coupled to prose wording or matching strings in SQL when a database assertion can
establish the behavior.

### Test local dependency candidates

Install locally packed dependencies without saving their paths, then select the same artifacts for
packed-consumer tests:

```sh
npm install --no-save --package-lock=false --ignore-scripts /absolute/path/pgclear.tgz /absolute/path/pgclear-jobs.tgz
TENON_TEST_PGCLEAR_TARBALL=/absolute/path/pgclear.tgz TENON_TEST_JOBS_TARBALL=/absolute/path/pgclear-jobs.tgz npm run check
```

Either candidate can be selected independently. The harness overrides transitive resolution to use
that artifact; omitted variables use registry dependencies. Jobs owns the real Next.js host fixture
and its native worker tests. Tenon keeps the ORM worker entry and guarded HTTP-host integration checks.

Tenon 0.5.1 currently requires the prepared but unpublished pgclear 0.3.6 and Jobs 0.2.2 patches.
Until they are published, use the local packed-artifact workflow above. Their lockfile entries reserve
those versions without invented registry URLs or integrity values. Before a future release, publish
those verified supporting artifacts first, regenerate registry metadata with
`npm install --package-lock-only --ignore-scripts`, review that only the intended dependency entries
change, then run `npm ci` and the complete checks without candidate overrides. No registry-only
clean-install verification is claimed while those required versions remain unpublished.

### Regenerate the fixture

First confirm that `tenon_fixture` is an unused scratch schema. Create a temporary `tenon.fixture.config.mjs` in the repository root:

```js
export const fixture = {
  connection:
    process.env.TENON_TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/tenon_orm_test',
  migrations: { directory: 'test/fixtures/migrations', namespace: 'tenon_fixture' },
  generate: { out: 'test/fixtures/generated-schema.ts' },
};
```

```sh
npm run build
node dist/cli.js migrate --config tenon.fixture.config.mjs
node dist/cli.js generate --config tenon.fixture.config.mjs
node dist/cli.js generate --config tenon.fixture.config.mjs --check
```

Generation uses the configured connection/codecs. Remove the scratch schema and temporary config
afterward. Replay changed fixture migrations into a fresh schema. Application migration history
remains immutable.

## Source layout

| Responsibility                                          | Location                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| Public exports                                          | `src/index.ts`, with source checking in `src/check.ts`          |
| SQL templates and mutation fragments                    | `src/query.ts`, `src/mutations.ts`                              |
| Query options, results, observations, guards            | `src/client.ts`, `src/query-options.ts`, `src/affected-rows.ts` |
| Pool lifetime and callback transactions                 | `src/connection.ts`, `src/database.ts`, `src/transaction.ts`    |
| Catalog reads, schema summaries, declarations, output   | `src/generate.ts`, `src/generation/`                            |
| Versioned schema snapshots and fingerprints             | `src/schema.ts`, `src/schema/`                                  |
| Migration files, history, locks, baselines              | `src/migrations.ts`, `src/migrations/`, `src/baseline.ts`       |
| Describe sessions, metadata, reports                    | `src/describe.ts`, `src/inspection/`                            |
| Source discovery, composition recovery, type comparison | `src/check/`                                                    |
| Config values, discovery, initialization                | `src/config.ts`, `src/config/`                                  |
| CLI dispatch                                            | `src/cli.ts`                                                    |

Pgclear owns execution, Describe, conversion, and recovery. Tenon owns SQL composition, database
schema interpretation, application tooling, and write guards. Use the public driver APIs; see
[driver considerations](CONSIDERATIONS.md) when changing that boundary. TypeScript is a runtime
tooling dependency loaded only through source checking.

`dist/` and `.test-dist/` are disposable. Build removes both before compiling; `npm run clean`
removes them independently.

## Documentation

The [README](README.md) is the entry point. It links seven consumer guides: getting-started, queries, database, types, checking, jobs and
reference. Keep concepts in their owning guide and exact lookup tables in the reference. The README, all of `docs/`, and [changelog](CHANGELOG.md) ship in the package. This guide
and `CONSIDERATIONS.md` stay in the repository.

When changing documentation, check examples against actual public imports, schema assumptions,
input/output types, and execution behavior. Verify relative links and section anchors, including
links and heading anchors inside the installed package. Use repository URLs for maintainer-only files. Keep API
contracts in the reference or focused guide and link to them instead of repeating the details in
every introduction.

Keep current boundary decisions in [CONSIDERATIONS.md](CONSIDERATIONS.md). The short
[0.5.0 scope note](notes/0.5.0-plan.md) retains release choices and deferred requests; Git history
preserves completed investigations and retired implementation plans.

## Release

Update `package.json`, `package-lock.json`, and the changelog together. Changelog entries should
describe consumer-visible changes and required upgrade actions; keep investigations in repository
notes. Documentation-only releases use a new patch version.

Run `npm run check`, inspect PostgreSQL 16/18 CI, review the source diff, and inspect
`npm pack --dry-run`. The artifact should include compiled code/declarations, README, license,
consumer guides, and changelog. Packed-consumer tests check relative documentation targets.

Before an explicitly requested publish, start from `npm ci` and run `npm publish --dry-run` against
the dedicated test database. This exercises `prepublishOnly` (full checks) and `prepack` (clean
build) without publishing. The final build removes `.test-dist/`; that is expected. Verify matching
manifest/lockfile versions and published registry dependencies, without candidate overrides.

Publishing requires an explicit request. The package is `@kequtech/tenon-orm`.

`npm run benchmark` measures sequential queries, whole transactions, guarded writes, and batching on
a warm single-connection pool. Local timings do not establish production throughput.

## Consumer experiments and package identity

Install local Tenon, Jobs and pgclear artifacts in an isolated consumer copy with its existing
package manager. Preserve unrelated resolutions and keep local paths out of committed manifests.
Direct tarball dependencies alone do not guarantee that transitive dependencies select those same
artifacts, particularly when a registry package has the same version number.

With pnpm, use temporary workspace overrides for all three selected packages, merging with existing
overrides rather than replacing them. For workspaces using `pnpm-workspace.yaml`, the shape is:

```yaml
overrides:
  '@kequtech/tenon-orm': file:/absolute/path/tenon.tgz
  '@kequtech/pgclear-jobs': file:/absolute/path/pgclear-jobs.tgz
  '@kequtech/pgclear': file:/absolute/path/pgclear.tgz
```

Reinstall in the disposable copy and inspect actual resolution from the application's, Tenon's and
Jobs' entry points. Compare real module paths and the original driver error classes, not just version
strings or package-manager summaries. A duplicate driver can break identity-based error handling.
The npm packed-consumer harness applies the equivalent transitive overrides for selected candidates.

Keep the reviewed artifact immutable. Put a changed candidate in a new directory and record its
hash; a matching version string is not proof that two local tarballs contain the same build.
