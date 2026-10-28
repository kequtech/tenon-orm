# pg considerations

Tenon pins **`pg@8.23.1`** and **`@types/pg@8.23.1`** in [package.json](package.json). This records
driver-dependent decisions for future upgrades. Public contracts belong in the
[reference](docs/reference.md); consumer changes belong in the [changelog](CHANGELOG.md).

## Describe and unnamed queries

[Inspection](src/inspection/protocol.ts) uses pg's documented
[custom-query dispatch](https://node-postgres.com/apis/client#clientquery) (`Submittable`). The
adapter sends Parse, Describe, and Sync for the unnamed statement. It collects parameter OIDs and
result fields without Bind or Execute; pg retains connection, authentication, TLS, protocol
encoding, and error handling. Inspection owns a separate `Client` with `pipeline: false`, because
custom query objects cannot use pg 8.23.1 pipelining. The `Connection` methods and event handlers
used here are a version-sensitive boundary. Completion must go through the query's `callback`, which
pg wraps to clear `query_timeout` timers; settling only Tenon's promise leaks those timers.
Inspection's own catalog/session functions are qualified with `pg_catalog` so the inspected search
path cannot shadow them. Retain all [Describe tests](test/describe.test.ts) and
[session tests](test/describe-session.test.ts) when upgrading.

[Application execution](src/connection.ts) uses `queryMode: 'extended'` without a statement name.
This enforces one statement even without values and avoids named-statement caching. In 8.23.1, a
JavaScript serialization failure after named Parse can leave the client believing the name exists
when PostgreSQL has discarded it; the next execution then fails with SQLSTATE 26000. Keep
[preparation tests](test/preparation.test.ts), including concurrent result ownership and savepoint
recovery. Native calls retain pg's configuration. `queryMode` is implemented by pg but omitted from
`@types/pg@8.23.1`'s `QueryConfig`; the local intersection only types that option. Remove it when
upstream declarations include it. Queries use PostgreSQL's 65,535-parameter protocol limit.

## Ownership and shutdown

Native `pool.end()` waits for checked-out clients, has no deadline, and does not drain queued
acquisitions. Tenon lets already-accepted Tenon operations drain before ending the pool, bounded by
the same shutdown deadline. Expiry rejects those operations; application callbacks can still finish
later. The owned connection keeps drainage, expiry, and its timer together; borrowed pools need no
operation tracker. Public `acquire`/`release` events track checkouts, including native ones.
`pool.end()` handles idle clients; the deadline calls `client.end()` only on remaining checkouts,
avoiding duplicate termination. Deadline termination runs in the shutdown promise chain so a
synchronous native termination failure rejects the shared close promise. It does not inspect or
replace sockets, reconnect clients, issue CancelRequests, or cancel application callbacks. Borrowed
pools keep their owner's lifecycle and idle-error policy; owned pools report idle errors as process
warnings.

In pg 8.23.1, ending a busy non-pipelined client destroys its transport; pipelined clients drain
native queries, and idle clients close gracefully. The timeout bounds Tenon's wait and operations,
not every native transport's teardown. Ending during stalled initial authentication can leave the
outstanding acquisition promise pending; ending is not a substitute for `connectionTimeoutMillis`.
Tenon leaves pg's default of no acquisition timeout unchanged. Callers that need bounded connection
establishment must configure that option. An authentication connection can outlive `db.close()`
until pg connects, fails, or times out; a late checkout is ended. [Shutdown](test/native.test.ts),
[native listener](test/listener-shutdown.test.ts),
[connection-failure](test/connection-failures.test.ts), and [reservation](test/reservation.test.ts)
regressions cover drainage, deadlines, lost-session rejection, fresh acquisitions, and isolation.
Default-timeout tests also hold authentication open, then allow it to succeed or fail after close:
expired writes and transaction callbacks must never run, and late checkouts must close. A lost
transaction never resumes on a replacement backend. Native listener reconnection belongs to the
application.

## Default value representations

Tenon leaves pg parsers and serialization unchanged, including on borrowed pools. Generation and
inspection share [verified mappings](src/driver/types.ts). Numeric scalars are strings but numeric
arrays are numbers and can lose precision. Temporal infinities are numbers; date-only and unzoned
timestamps use Node's timezone. JSON input strings are already-encoded JSON, while JavaScript arrays
serialize as PostgreSQL arrays. Generated JSON writes therefore use strings. Custom parsers require
application-owned type adjustments and are not inferred by Describe.

Retain [driver](test/driver.test.ts), [generated-value](test/generation-values.test.ts),
[generated-input](test/generation-inputs.test.ts), and [domain](test/generation-domains.test.ts)
regressions. Run `npm run check`, inspect the packed package, and verify the PostgreSQL 16/18 CI
matrix on driver upgrades. Update this file for the installed version and document only
consumer-visible differences in the changelog.
