# Unfinished work

Tenon is experimental. The [README](../README.md) describes implemented behavior;
[design-decisions.md](design-decisions.md) records settled boundaries. SQL
migrations, ordinary generated types, inline SQL, named operations, callback
transactions, ISC licensing and the `@kequtech/tenon-orm` package name are settled.

## Before public distribution

- [x] Use a separate public repository for a fresh source baseline while retaining
  previous development history privately. The owner created the new repository;
  old commits and conversation checkpoint refs must not be transferred. See
  [releasing.md](releasing.md).
- [ ] Review and push the cleaned initial source baseline to the new repository.
- [ ] Approve npm publication separately from source visibility. Keep
  `private: true` until an npm release is explicitly approved. Choose an actual
  release version and, for a prerelease, its dist-tag; `0.0.0` is a placeholder.
- [ ] Run the configured PostgreSQL 16/18 CI matrix and inspect the results.
  Local PostgreSQL 16.15 evidence does not establish compatibility with 18.
- [ ] Verify the final npm tarball, metadata and documentation links against the
  chosen repository, including the installed CLI and minimum consumer compiler.
  Configure npm organization permissions and publishing credentials only when
  needed for the approved release.

## Correctness and adoption evidence

- [ ] Harden transaction connection-loss and rollback-failure behavior with
  fault tests. Explicit savepoints, isolation and application-owned retries are
  settled; nested transaction helpers remain deferred.
- [ ] Exercise realistic agent consumer workflows: migrations/backfills, joins,
  transaction mistakes and ordinary application changes. Measure correctness,
  unnoticed defects, repairs, human intervention, time and tokens against plain
  pg plus generated types and another typed database tool. API preferences alone
  are not evidence of usefulness.
- [ ] Verify deployment compatibility and recovery on a real consumer beyond the
  documented baseline-adoption workflow. File checksums do not detect manual
  schema changes; latest-schema verification needs fresh migration replay.
- [ ] Extend verified PostgreSQL value mappings when a consumer needs them.
  Unmapped columns intentionally fall back to `unknown` with warnings. Views,
  materialized views and foreign tables intentionally use manual query types.
- [ ] Measure compile/editor responsiveness with large registries and schemas,
  generation catalog-query costs, execution overhead and bulk SQL performance.
  No comparative performance benchmark has been run.

## Deferred unless a concrete need appears

Nontransactional migration execution, automatic drift reconciliation, resumable
backfills, SQL analysis, machine-readable diagnostics, custom parser mappings,
explicit caller cancellation, streaming helpers, nested transaction callbacks
and additional execution settings are not current implementation requirements.
Do not restore a CRUD/relation DSL, runtime schema constructors or implicit SQL
rewriting. Reopen settled choices only for demonstrated application needs.
