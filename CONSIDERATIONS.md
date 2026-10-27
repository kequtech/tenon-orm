# Postgres.js considerations

Tenon uses **`postgres@3.4.9` as a pinned runtime dependency**, recorded in
[package.json](package.json) and [package-lock.json](package-lock.json). This document records
driver workarounds and Tenon-specific behavior for maintainers evaluating an upgrade. Public
usage belongs in [docs/reference.md](docs/reference.md); release changes belong in
[CHANGELOG.md](CHANGELOG.md).

Reviewed **2026-10-27** against the installed 3.4.9 source and the linked upstream reports.
The linked PRs were open at that review. A proposed fix, or a merged PR, does not establish that
a particular published version contains the fix or satisfies Tenon's contracts.

## SQL NULL array elements

In 3.4.9, unquoted array `NULL` tokens reach the element parser. Depending on the element type,
this produces a string, NaN, false, an invalid date, or a parsing error instead of JavaScript null.
See issues [#1049](https://github.com/porsager/postgres/issues/1049) and
[#1124](https://github.com/porsager/postgres/issues/1124), and proposed fix
[#1258](https://github.com/porsager/postgres/pull/1258).

[src/driver/array.ts](src/driver/array.ts) reads array type IDs, element types, and delimiters from
`pg_type`, then replaces array parsers once per client. It handles quoted `"NULL"`, empty strings,
escapes, nesting, and dimension prefixes. Non-null elements retain the existing scalar parser;
explicit custom array parsers are left alone. Serializers are unchanged. This also modifies array
parsers on a client borrowed from the application.

Keep [test/driver.test.ts](test/driver.test.ts), including the borrowed-client prepared-query and
custom-parser cases, plus the array coverage in [test/generation-values.test.ts](test/generation-values.test.ts).
Remove the replacement only when these cases pass using the candidate driver's own parsers.

## Connection loss and reserved sessions

When PostgreSQL ends a session, it rolls back its uncommitted transaction and releases its advisory locks. Its JavaScript
callback can continue running. In 3.4.9, an old reserved handle can then submit work to a closed
or reused connection, and releasing a dead reservation can leave the pool unusable. See
[#1248](https://github.com/porsager/postgres/issues/1248), reserved-handle fix
[#1240](https://github.com/porsager/postgres/pull/1240), and transaction-scope fix
[#1215](https://github.com/porsager/postgres/pull/1215).

[src/driver/lifecycle.ts](src/driver/lifecycle.ts) observes `onclose` and associates each reservation
with a driver connection ID using a marked initial statement and a temporary `debug` callback.
Transactions register on BEGIN itself; other reservations use a SELECT probe. Registration finishes
before the reserved handle is returned, and failed initialization discards the reservation.
[src/driver/session.ts](src/driver/session.ts) rejects pending and subsequent operations after
that connection closes. It avoids sending cleanup SQL or calling the native `release()` on a
reservation already known to be closed. Transactions and migration locks share this protection.
If rollback or advisory-unlock cleanup fails on a session not known to be closed, Tenon attempts
to terminate that backend rather than return its uncertain state to the pool.

The temporary debug hook preserves the application's callback and restores its original setting.
Leaving debug enabled would change the driver's error-property enumerability, exposing SQL and
parameters through ordinary error serialization. Registration must remain installed until actual
query dispatch: even `.execute()` dispatches through a microtask in the
[3.4.9 query implementation](https://github.com/porsager/postgres/blob/v3.4.9/src/query.js).

[test/connection-failures.test.ts](test/connection-failures.test.ts) terminates real backends and
checks rollback, rejected late work, fresh-session recovery, released advisory locks, and isolation
from another active transaction. [test/tool-connections.test.ts](test/tool-connections.test.ts)
and [test/transactions.test.ts](test/transactions.test.ts) cover failed cleanup and error preservation.
Remove driver-specific observation only after the replacement behavior passes these tests.

## Reservation startup and reconnects

Tenon executes `SELECT 1` before `reserve()` because 3.4.9 can strand reservation acquisition on
startup or reconnect paths. It also races acquisition against observed connection closure and
releases a reservation that arrives after its acquisition was abandoned. Relevant upstream work:
[#1229](https://github.com/porsager/postgres/pull/1229) for reservations stranded after termination;
[#1219](https://github.com/porsager/postgres/issues/1219) and
[#1220](https://github.com/porsager/postgres/pull/1220) for cold reservations with `fetch_types: false`.
These are related paths, not interchangeable reproductions.

Transaction registration shares BEGIN, leaving one extra warmup query per transaction. Tooling and
other reservations retain a separate connection-ID probe as well. Ordinary unguarded queries do
not reserve a session. [test/reservation.test.ts](test/reservation.test.ts) starts untouched clients
with `fetch_types` both enabled and disabled, checks three simultaneous transaction backends and
stable transaction IDs, verifies the caller's debug hook is restored, and exercises tooling locks.
Removing the warmup from disposable compiled test output made the concurrent `fetch_types: false`
case time out; the normal implementation passed. Keep the warmup until a replacement passes these
tests and the reconnect tests without additional pool-state assumptions.

These guards do not repair every driver startup failure. Application connections retain the driver's
automatic type-fetch default. Broader startup/type-fetch failures remain an upgrade consideration;
see proposed fix [#1241](https://github.com/porsager/postgres/pull/1241).

### Transaction overhead measurements

`npm run benchmark` measures complete warm transactions and SQL dispatch counts. In a local
before/after run on PostgreSQL 16.15, with 100 measured calls per case on a single-connection pool:

| Operation                                       | SQL dispatches before → after | Median milliseconds before → after |
| ----------------------------------------------- | ----------------------------- | ---------------------------------- |
| Empty transaction                               | 4 → 3                         | 0.659 → 0.508                      |
| One-query transaction                           | 5 → 4                         | 1.103 → 0.896                      |
| Three-query transaction                         | 7 → 6                         | 1.708 → 1.514                      |
| Standalone guarded write                        | 5 → 4                         | 1.254 → 0.985                      |
| Three-query transaction with two guarded writes | 11 → 10                       | 4.597 → 4.623                      |

The one-dispatch reduction is deterministic; timings vary, and the guarded multi-query case did not
improve in this run. This table isolates the bootstrap change with application preparation off.
SQL dispatch counts are not protocol round-trip counts. In the
[3.4.9 protocol builder](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js), an
unprepared parameterized query performs Describe before binding, so driver protocol costs remain
even after removing Tenon's extra SELECT. The current benchmark compares prepared and unprepared
native queries with Tenon's normal unprepared execution, including complete transactions.

Batching remains caller-controlled: ten separate inserts used 13 dispatches after the change,
while one ten-row insert inside a transaction used 4. Each guarded write inside a transaction adds
SAVEPOINT and RELEASE commands on success. These measurements establish costs of the exercised
local paths, not expected production throughput or behavior across a proxy.

## Compiled-query execution choices

[src/connection.ts](src/connection.ts) submits detached SQL and values through native `unsafe`:

- `simple: false` enforces one statement per application query, including queries without values.
  Migration scripts deliberately use the driver's multi-statement path instead.
- `prepare: false` disables named statement reuse for application queries even if the client has
  `prepare: true`. The parser-cache and pipeline findings below explain this policy. Transaction
  controls and migration scripts also use native unprepared execution.
- JavaScript arrays use `sql.typed(value, 0)` so SQL context establishes whether the target is a
  PostgreSQL array or JSON. The driver still serializes the value. Cast standalone parameters;
  Describe does not inspect JavaScript values and cannot reproduce value-based type inference.
- [src/query.ts](src/query.ts) rejects more than **65,533** parameters because the pinned driver
  rejects counts `>= 65534`. This is a driver-version limit, not a claim about PostgreSQL's limit;
  see the [3.4.9 execution code](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js).

Verification is in [test/driver.test.ts](test/driver.test.ts), the single-statement cases in
[test/database.test.ts](test/database.test.ts), and the composition/bind-limit cases in
[test/mutations.test.ts](test/mutations.test.ts) and [test/composition.test.ts](test/composition.test.ts).

### Parser caching and prepared execution

The driver stores each column's parser function in its cached statement metadata when it receives
RowDescription. Replacing `client.options.parsers[arrayOid]` does not update those stored function
references. An experiment on 3.4.9 prepared an integer-array query, installed Tenon's correction,
then reused that native prepared statement: the result remained `[1, NaN, 3]` instead of `[1, null, 3]`.

A prototype prefixed submitted SQL with the stable comment
`/* @kequtech/tenon-orm:array-null-v1 */`. Because Postgres.js keys its cache by SQL text and input
type IDs, this created a separate entry after corrected parsers were installed. Repeated calls
reused the corrected parser. This solved the parser-cache problem with a small execution change,
without a second cache or driver-internal mutation. It is **not enabled**: the independent pipeline
failure below makes prepared application execution unsafe in the tested configuration.

Current unprepared execution reads fresh column metadata and avoids those stale parser references.
[test/preparation.test.ts](test/preparation.test.ts) checks pre-described borrowed clients with
preparation both enabled and disabled at client level, including repeated and transactional queries
with arrays, JSON and bigint values.

### Serialization failures while pipelining

With preparation enabled in the prototype, a warmed `SELECT $1::jsonb` and three concurrent requests
on a `max: 1` client exposed response misassociation:

1. The first request contained valid JSON, the second contained an unserializable nested BigInt,
   and the third contained different valid JSON.
2. The first request received the second request's serialization error.
3. The second request received the third request's successful result; the third never settled.

The preparation-off control correctly fulfilled the first and third requests and rejected only the
second. Upstream [#1236](https://github.com/porsager/postgres/pull/1236) describes this queue/serialization
failure and proposes a driver fix. This is a stronger reason to retain unprepared execution than
parser caching alone. The concurrent regression in [test/preparation.test.ts](test/preparation.test.ts)
protects result ownership and continued client usability; its guarded-transaction case checks recovery
from a serialization failure without losing earlier work.

Reducing `max_pipeline` from its default 100 to 1 still reproduced the failure. Setting it to 0
settled these three requests correctly, but a subsequent native `begin()` failed with an undefined
connection and a follow-up uncaught driver error. Globally changing that setting is therefore not
a reliable remedy, particularly for borrowed clients also used outside Tenon. Serializing every root
query would add scheduling policy and reduce concurrency. Neither change is installed.

### Prepared execution tradeoffs

The prototype passed the then-current 149-test suite, additional parser/transaction checks, and the
Mail/Identity pilots before the concurrent failure was found. In a local warm-pool comparison with
100 samples per case, preparation reduced median query time from 0.442 to 0.235 ms and a complete
three-query transaction from 1.526 to 1.057 ms. These measurements show a potential benefit, not a
safe release configuration or production throughput guarantee.

Postgres.js 3.4.9 also retries selected stale/missing prepared-statement errors. Probes found a
changed-result-shape write refreshed outside a transaction without duplicating its effect. Tenon's
serialized transactions preserved rollback and guarded savepoint recovery in the exercised cases.
Upstream [#1239](https://github.com/porsager/postgres/pull/1239) addresses unsafe retry behavior when
transaction commands are pipelined. Recheck both upstream fixes, parser isolation, serialization
failures, stale plans, and transaction boundaries before enabling preparation. A separate policy
for transaction-only preparation would need its own justification and tests.

Transaction-pooling proxies must also support protocol-level named statements; see
[PgBouncer's prepared-statement support](https://www.pgbouncer.org/config.html#max_prepared_statements).
These experiments used direct PostgreSQL 16.15, not a proxy.

## Driver defaults and Tenon overrides

These are Postgres.js 3.4.9 defaults before URI, environment, or caller configuration. The
[driver options](https://github.com/porsager/postgres/tree/v3.4.9#connection-details),
[raw-query implementation](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js), and
[protocol builder](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js) distinguish
client settings from per-query choices.

| Setting                        | Native default                                                                                  | Tenon application execution                                                         | Inspection                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Client `prepare`               | `true`; tagged queries request preparation, `.unsafe` defaults to `false` per query             | Explicitly `false`, regardless of client setting                                    | Describe requests preparation; client `false` still wins |
| `simple` protocol              | Tagged queries use extended; `.unsafe` uses simple with no parameters, extended with parameters | Always extended for application queries; trusted migration batches use simple       | Describe uses extended                                   |
| `fetch_types`                  | `true`                                                                                          | Inherited; Tenon also installs its array correction once per client                 | `false`; explicit metadata reads/array setup             |
| Pool `max`                     | 10                                                                                              | Inherited                                                                           | 1                                                        |
| `connect_timeout`              | 30 seconds                                                                                      | Inherited                                                                           | 3 seconds by default                                     |
| `idle_timeout`                 | Disabled                                                                                        | Inherited                                                                           | Inherited; client is closed after inspection             |
| `max_lifetime`                 | Random 30–60 minutes                                                                            | Inherited                                                                           | Inherited; short-lived client                            |
| `max_pipeline`                 | 100                                                                                             | Inherited; Tenon separately queues transaction operations for savepoint correctness | Inherited                                                |
| `ssl`                          | `false`                                                                                         | Inherited from connection configuration                                             | Inherited from connection URI                            |
| `debug`                        | `false`                                                                                         | Caller setting restored after temporary reservation registration                    | Native default                                           |
| Server statement/lock timeouts | Server/session configuration                                                                    | Inherited                                                                           | Configured to 5 seconds / 1 second by default            |

Inspecting a query still does not bind or execute it. Connection/authentication, value serializers,
SSL configuration, and most pool behavior remain native. Internal tagged metadata/warmup queries
can still prepare according to the client setting; the forced-off policy concerns compiled
application SQL. The array NULL correction and the documented reservation safeguards are separate
from prepared-statement reuse.

## Native driver access and LISTEN lifecycle

`db.native` exposes the actual pool-level client. Native operations bypass Tenon's transaction
guarantees and execution/preparation policy. Array correction remains shared client state,
installed when Tenon first initializes execution; native access alone does not install it. Keep
[test/native.test.ts](test/native.test.ts) for pool identity, transaction separation, and owned/borrowed
shutdown, including dedicated LISTEN connections.

The native `.listen()` helper replaces the caller's `onclose` handler. Its readiness callback runs
on subscription and resubscription, but it does not expose the corresponding disconnect callback;
see the [pinned implementation](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js).
Original unsubscribe handles can retain callbacks after reconnect; a local two-subscriber probe
reproduced [#1243](https://github.com/porsager/postgres/issues/1243). Application recovery and native
subscription ownership remain outside Tenon's query API.

Block Party's reported reconnect/shutdown race also reproduced through owned `db.close()` on
PostgreSQL 16.15. After close returned, restoring a test proxy produced a new idle backend without
another readiness callback. The driver's `reconnect()` leaves a timer queued, and `connect()` resets
the termination flag when that timer fires. This differs from the unsubscribe-identity defect; no
separate upstream shutdown-issue link was supplied.

[src/driver/listener.ts](src/driver/listener.ts) guards only the dedicated native LISTEN transport of
Tenon-owned clients. It temporarily supplies the documented socket factory while `.listen()`
synchronously clones its client options, then restores the query pool's configuration. The factory
refuses creation after owned shutdown, disposes tracked sockets, and destroys a caller factory's
late result. Default TCP/Unix dialing uses Node sockets; writes buffer while TCP connects, leaving
connection timeouts, authentication, TLS and reconnect scheduling with Postgres.js. TCP host rotation
and TLS host metadata are retained. The driver, not Tenon, still owns subscription state and payloads.

Use `db.close()` for this protection. Direct native `end()` and borrowed-client shutdown remain
caller-owned. No native listener-disconnected API or reconnect-safe unsubscribe handle is added.
[test/listener-shutdown.test.ts](test/listener-shutdown.test.ts) covers interrupted reconnect,
pending initial setup, ordinary reconnect/delivery, and a custom socket resolving after disposal.
Disabling the guard made the regression fail; the fixed reproduction had no restored backend or
proxy socket. Local TLS-required shutdown and multi-host failover probes also passed; these are
not a TLS CI matrix. Remove the guard only after these behaviors pass without it, including owned
shutdown through the public API and continued usability of borrowed clients.

## Transaction behavior owned by Tenon

[src/transaction.ts](src/transaction.ts) manages explicit SQL boundaries on a reserved session,
rather than delegating the callback to native `begin()`. The
[3.4.9 transaction implementation](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js)
remembers statement errors even when application SQL later recovers through a manual savepoint.
Tenon permits that recovery and also implements `affectedRows` savepoints.

Tenon queues whole operations, including savepoint cleanup, so concurrent calls cannot enter a
different operation's rollback boundary. Accepted pending work finishes before transaction cleanup;
the callback client expires when the callback finishes. Failed savepoint recovery prevents commit
even if application code catches the error. Finally, Tenon verifies that `COMMIT` actually returns
the `COMMIT` command tag; see the false-success report
[#1217](https://github.com/porsager/postgres/issues/1217).

These API guarantees remain necessary even if upstream connection bugs are fixed. Before adopting
native transactions, retain the manual-savepoint cases in [test/database.test.ts](test/database.test.ts),
guarded-write cases in [test/affected-rows.test.ts](test/affected-rows.test.ts), and scope/cleanup
cases in [test/transactions.test.ts](test/transactions.test.ts).

Tenon does not resume lost transactions, retry operations, or cancel arbitrary application code
inside a callback. A connection lost around COMMIT can leave the outcome unknown. Applications
own retry policy, idempotency, and coordination with external effects.

## Inspection and value mappings

[src/inspection/connection.ts](src/inspection/connection.ts) owns a separate client with `max: 1`,
`fetch_types: false`, connection/statement/lock timeouts, bounded cleanup, and explicit session overrides.
It performs its own metadata reads and array setup. These are inspection policies; application
connections do not receive these timeout defaults. Test them through
[test/describe-session.test.ts](test/describe-session.test.ts).

[src/driver/types.ts](src/driver/types.ts) records verified read/write representations shared by
generation and inspection. Apart from the array NULL correction, Tenon retains native value
conversions. An upgrade must compare actual values with these mappings, especially numeric arrays,
JSON, dates and infinities, byte arrays, enums, and domains. Unverified types stay conservative;
custom application parsers are not inferred. See [test/generation-values.test.ts](test/generation-values.test.ts),
[test/generation-domains.test.ts](test/generation-domains.test.ts), and
[test/describe.test.ts](test/describe.test.ts).

## Pilot-only error adaptation

Postgres.js query errors have a read-only `stack` on affected Node versions; see
[#1227](https://github.com/porsager/postgres/issues/1227). Kysely's pg dialect tries to append to it.
The bridge in [test/pilots/run.mjs](test/pilots/run.mjs) copies the error into a writable Error with
the original as its cause. This is confined to the pilot fixture. Tenon's runtime returns native
driver errors unchanged. Revisit this bridge when updating the pilot's driver or Kysely version.

## Upgrading the pinned driver

1. Check the candidate release contents against these links and the installed source. Remove a
   workaround only after testing the candidate without it; keep the behavioral regression tests.
2. Update the package and lockfile together. Review type mappings, statement options, callback
   scheduling, parser caching, and the parameter limit rather than assuming patch-version compatibility.
3. Run `npm run check`, the PostgreSQL 16/18 CI matrix, and the
   [Mail/Identity pilots](test/pilots/README.md). Inspect the packed consumer artifact. Tests establish
   the exercised workflows, not every network failure or deployment environment.
4. Update this record and its review date. Describe user-visible changes in the changelog and keep
   ordinary usage guidance in the core docs.
