# Release preparation

## Verify the release

1. Review the final source diff and package contents. Run `npm run check` against
   the dedicated test database and inspect the PostgreSQL 16/18 CI results. A local
   pass on 16 is not evidence that 18 passes.
2. Install the tarball in a consumer and exercise migrations, generated
   types, queries, and deployment from the installed package. The automated consumer
   test already verifies exports, the CLI, both compiler versions, and production
   imports without development typings.
3. Confirm documentation links, license, and npm organization
   access. Choose the release version and channel; update package metadata and the
   lockfile together. Use a prerelease tag for a prerelease.
4. If the development checkout uses `private: true`, remove it for the release. Inspect the final
   archive again, then publish explicitly using the chosen publishing identity.
   Use the configured publishing method.

```sh
npm ci
npm run check
npm pack --dry-run
npm pack --pack-destination /path/to/review-directory
```

`prepack` builds clean outputs and marks the CLI executable. The package allowlist
contains compiled JavaScript, declarations, and user documentation; npm also
includes README, LICENSE, and package.json. No source maps, tests, credentials, or
agent captures belong in the archive. `prepublishOnly` runs the complete suite,
including its database preflight. Publishing an existing tarball is still a
separate action; lifecycle hooks do not replace artifact review.

## Verify deployment

Use a disposable instance with the product's actual PostgreSQL major, connection
proxy, and permissions to rehearse:

- Applying migrations from empty and from the previous release, then starting the
  packed application with only production dependencies.
- Overlapping old/new application versions with compatible schema changes.
- A failed migration, a disconnected transaction, and an interrupted deployment.
  The suite covers live backend termination and simulated cleanup failures; it
  does not establish recovery from every network or commit-acknowledgment failure.
- Restoring a backup and verifying the application's data, not merely rerunning
  migrations. Down files cannot recover discarded data.

Migration tools need direct connections or session pooling for their session
advisory locks. Transaction-only migrations cannot create indexes concurrently;
plan that maintenance separately. Treat baseline adoption as an assertion that
the target already matches the captured checkpoint, not a schema comparison.

There is no separate roadmap: release checks live here, behavior in the
[reference](reference.md), and unresolved tradeoffs in [design decisions](design-decisions.md).

## Local lifecycle and guard cost

The installed consumer test exercises migrations, generation, direct operations,
an additive upgrade with old/new projections, migration failure/repair, rollback,
baseline adoption, and schema replay with a logical row snapshot and restored
identity sequence. The separate connection tests exercise backend loss. This is
not a physical backup/PITR rehearsal or a test of a hosted proxy and deployment
runner; perform those in the first product's environment before launch.

Run `npm run benchmark` against the dedicated test database for a reproducible
sequential microbenchmark. On local PostgreSQL 16, 50 samples gave these medians:

| Call                                | Local   | With simulated 5 ms per driver query |
| ----------------------------------- | ------- | ------------------------------------ |
| pg query                            | 0.26 ms | 5.49 ms                              |
| Tenon query                         | 0.30 ms | 5.54 ms                              |
| Tenon query with affectedRows       | 0.63 ms | 16.46 ms                             |
| Transaction query                   | 0.23 ms | 5.45 ms                              |
| Transaction query with affectedRows | 0.49 ms | 16.40 ms                             |

These are observations, not performance guarantees. The latency simulation delays
each driver call; it is not a real network test. Transaction figures exclude the
outer BEGIN/COMMIT. Successful guarded calls send three commands instead of one.
Use constraints where the expectation matters and measure the product workload.
