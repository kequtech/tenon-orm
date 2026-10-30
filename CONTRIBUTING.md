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
namespaces. Some tests need permission to create roles; connection-failure tests terminate their
own backends. Scripts do not load `.env` automatically.

CI runs PostgreSQL 16 and 18 with matching `pg_dump` clients. Packed-consumer tests install the actual
artifact and compile public/generated types with TypeScript 6 and 7, without repository development
dependencies. They prefer npm's cache and fetch missing packages/metadata. No application checkout
or third-party ORM installation is required.

Test observable workflows, function behavior, and compiler contracts. Add focused regressions for
bugs. Avoid tests coupled to prose wording or matching strings in SQL when a database assertion can
establish the behavior.

### Test an unpublished driver candidate

Install a fresh pgclear tarball without changing the lockfile, and pass the same artifact to
packed-consumer tests:

```sh
npm install --no-save --package-lock=false --ignore-scripts /absolute/path/pgclear-candidate.tgz
TENON_TEST_PGCLEAR_TARBALL=/absolute/path/pgclear-candidate.tgz npm run check
```

The consumer harness overrides Tenon's transitive dependency for this candidate. Ordinary checks
use the declared registry dependency. A coordinated unpublished patch may prepare a registry lock
entry using the final candidate's actual integrity; keep local paths out of committed dependencies.
Candidate checks do not establish registry availability. Before releasing Tenon, publish pgclear
first, verify its registry integrity against the lockfile, then run `npm ci` and ordinary checks.
Refresh the lockfile and rerun checks if the published artifact differs.

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

The [README](README.md) is the entry point. It links the first-use guide, task guides, and API/CLI
reference. The README, all of `docs/`, and [changelog](CHANGELOG.md) ship in the package. This guide
and `CONSIDERATIONS.md` stay in the repository.

When changing documentation, check examples against actual public imports, schema assumptions,
input/output types, and execution behavior. Verify relative links and section anchors, including
links inside the installed package. Use repository URLs for maintainer-only files. Keep API
contracts in the reference or focused guide and link to them instead of repeating the details in
every introduction.

Historical investigations in `notes/` are excluded from the package and are not current API docs.
The [integration brief](notes/tenon-pgclear-integration-brief.md) records the agreed driver boundary;
the [archived review](notes/pgclear-author-feedback-2026-10-28.md) explains the original investigation.

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
manifest/lockfile versions and a published registry driver, without a candidate override.

Publishing requires an explicit request. The package is `@kequtech/tenon-orm`.

`npm run benchmark` measures sequential queries, whole transactions, guarded writes, and batching on
a warm single-connection pool. Local timings do not establish production throughput.
