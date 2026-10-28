# Postgres.js considerations

Tenon pins **`postgres@3.4.9`** in [package.json](package.json) and
[package-lock.json](package-lock.json). This is a maintainer record of version-specific workarounds
and upgrade requirements. Public contracts belong in [the reference](docs/reference.md); release
changes belong in [the changelog](CHANGELOG.md).

The behavior below was checked against the installed 3.4.9 source. Upstream links provide context;
an issue resolution or merged PR does not establish that a published driver passes Tenon's tests.
Keep each behavioral regression when removing its workaround.

## SQL NULL array elements

In 3.4.9, unquoted array `NULL` reaches element parsers, producing strings, NaN, false, invalid
dates, or parse errors instead of JavaScript null. See [#1049](https://github.com/porsager/postgres/issues/1049),
[#1124](https://github.com/porsager/postgres/issues/1124), and proposed fix
[#1258](https://github.com/porsager/postgres/pull/1258).

[src/driver/array.ts](src/driver/array.ts) reads array/element OIDs and delimiters from `pg_type` and
installs corrected parsers once per client. Quoted `"NULL"`, escapes, dimensions, and non-null
scalar parsing retain their meanings; explicit custom array parsers remain untouched. Serializers
are unchanged. This also modifies parsers on borrowed clients.

Before removing it, pass [driver tests](test/driver.test.ts) and
[generated-value tests](test/generation-values.test.ts) with the candidate's own parsers, including
borrowed prepared clients, custom parsers, nested arrays, and null elements.

## Connection loss and reserved sessions

A disconnected backend has lost its transaction and advisory locks while JavaScript may still be
running. In 3.4.9, a stale reserved handle can submit work after reconnect, and releasing a dead
reservation can strand the pool. See [#1248](https://github.com/porsager/postgres/issues/1248),
[#1240](https://github.com/porsager/postgres/pull/1240), and
[#1215](https://github.com/porsager/postgres/pull/1215).

[src/driver/lifecycle.ts](src/driver/lifecycle.ts) observes `onclose` and associates reservations with
driver connection IDs through a marked initial statement and temporary `debug` callback.
Transactions register on BEGIN; tooling reservations use a SELECT probe. Registration lasts until
actual dispatch, which occurs through a microtask in the
[pinned query implementation](https://github.com/porsager/postgres/blob/v3.4.9/src/query.js).
The caller's debug callback is restored: leaving it enabled can expose SQL and parameters through
enumerable native error properties.

[src/driver/session.ts](src/driver/session.ts) rejects pending and later work after closure and avoids
cleanup SQL/native release on a known-dead reservation. If rollback or advisory-unlock cleanup
fails on a session not known to be closed, it attempts backend termination before pool reuse.

Keep [connection-failure](test/connection-failures.test.ts), [tooling](test/tool-connections.test.ts),
and [transaction](test/transactions.test.ts) coverage: late work must reject, locks must release,
unrelated transactions must survive, and work/cleanup errors must remain inspectable. Remove the
observation only after those cases pass without it.

## Reservation startup

Tenon issues `SELECT 1` before native `reserve()` because startup/reconnect paths can strand
acquisition. It races acquisition against observed closure and releases a reservation arriving
after abandonment. Relevant upstream work includes
[#1229](https://github.com/porsager/postgres/pull/1229),
[#1219](https://github.com/porsager/postgres/issues/1219), and
[#1220](https://github.com/porsager/postgres/pull/1220). Broader type-fetch startup behavior is covered
by proposed fix [#1241](https://github.com/porsager/postgres/pull/1241).

Keep [reservation tests](test/reservation.test.ts) with cold clients, concurrent reservations,
`fetch_types` enabled/disabled, restored debug configuration, tooling locks, and reconnects. Remove
the warmup only when these pass without extra pool-state assumptions. Runtime clients retain the
driver's automatic type-fetch default.

## Compiled-query execution choices

[src/connection.ts](src/connection.ts) executes detached SQL through native `unsafe` with:

- `simple: false`: one statement per application query, including parameterless queries.
  Migration scripts deliberately use the multi-statement path.
- `prepare: false`: no named statement reuse for compiled application queries, even on clients
  configured with `prepare: true`. Internal metadata/warmup queries still follow client defaults.
- `sql.typed(array, 0)`: PostgreSQL context distinguishes array and JSON parameters; the driver
  still serializes values. Standalone projections need SQL casts for inspection parity.

[src/query.ts](src/query.ts) limits a query to 65,533 parameters because the pinned
[execution code](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js) rejects counts
`>= 65534`. Recheck this driver limit before changing it.

Prepared metadata caches parser functions. Installing the array correction after a borrowed
client prepares a query does not update cached parser references. A stable SQL comment can isolate
new cache entries, but does not resolve the independent serialization/pipeline failure: a bad JSON
value in concurrent prepared requests can shift errors/results and leave a request unsettled.
See [#1236](https://github.com/porsager/postgres/pull/1236). Changing `max_pipeline` did not provide
a reliable replacement policy in the tested configuration.

Keep [preparation tests](test/preparation.test.ts), including result ownership, serialization
recovery, borrowed parsers, JSON/bigint/array values, and guarded writes. Before enabling preparation,
verify stale plans and transaction boundaries as well; see
[#1239](https://github.com/porsager/postgres/pull/1239). Validate the intended proxy environment.
`npm run benchmark` measures local costs; it does not establish production throughput.

## Constructor notification callback typing

Postgres.js 3.4.9 implements `onnotify(channel, payload)` but omits it from published `Options`.
[src/connection.ts](src/connection.ts) adds that type to `ConnectionOptions` and forwards it at
construction for plain options and `{ url, options }`. No notification dispatch is reimplemented.
The driver captures `onnotify` when building connection objects, so later option mutation is not
a supported installation method. See the pinned
[option parser](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js),
[connection implementation](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js), and
[declarations](https://github.com/porsager/postgres/blob/v3.4.9/types/index.d.ts).

[test/connection.test.ts](test/connection.test.ts) covers delivery, close observation after transaction
setup, URI parsing/precedence, and owned shutdown. Packed-consumer contracts check the callback
signature. Remove the local addition when the candidate's public types expose that signature and
the tests pass. This callback does not observe native `.listen()`'s private client's disconnects.

## Native driver access and LISTEN lifecycle

`db.native` is the real pool-level client. Native calls bypass Tenon's transaction guards and
execution policy. Array correction is shared state installed on first Tenon execution, not native
access. Keep [native tests](test/native.test.ts) for identity, transaction separation, and
owned/borrowed shutdown.

In the [pinned LISTEN implementation](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js),
`.listen()` creates a dedicated client with its own `onnotify` and `onclose`. Readiness runs on
subscription/resubscription, but the parent's close callback is not forwarded. Original unsubscribe
handles can retain callbacks after reconnect; see [#1243](https://github.com/porsager/postgres/issues/1243).
Tenon provides no reconnect-safe unsubscribe or listener-disconnected API.

A separate shutdown race lets a queued reconnect restore an idle backend after owned `db.close()`
returns. In 3.4.9, `reconnect()` can leave a timer queued and `connect()` resets termination when
that timer fires. This is distinct from unsubscribe identity.

[src/driver/listener.ts](src/driver/listener.ts) temporarily supplies the documented socket factory
while `.listen()` synchronously clones options for its private client, then restores query-pool
options. The factory refuses connections after owned shutdown, destroys tracked transports, and
disposes a caller factory's late result. Native code retains authentication, TLS negotiation,
connection timeouts, payloads, and reconnect scheduling. TCP host rotation and TLS host metadata
are preserved. The socket factory is also absent from published types; its local type extension
is confined to this guard.

The guard applies through `db.close()` to Tenon-owned clients. Direct native `end()` and borrowed
client shutdown remain caller-owned. Before removing it, pass
[listener shutdown tests](test/listener-shutdown.test.ts) without it: interrupted reconnect, pending
setup, ordinary delivery/reconnect, and late custom socket creation. Also verify TLS and multi-host
behavior for the candidate; the normal CI matrix does not establish those configurations.

## Transaction behavior owned by Tenon

[src/transaction.ts](src/transaction.ts) owns SQL transaction boundaries on reserved sessions.
Native `begin()` remembers statement errors even after manual-savepoint recovery. Tenon permits
that recovery, serializes complete operations/savepoint cleanup, waits for accepted pending work,
and expires the callback client before cleanup. Failed savepoint recovery prevents commit even if
caught. COMMIT must return the COMMIT tag; see
[#1217](https://github.com/porsager/postgres/issues/1217).

These are Tenon guarantees, independent of driver fixes. Any move to native transactions must
retain [database](test/database.test.ts), [affected-row](test/affected-rows.test.ts), and
[transaction](test/transactions.test.ts) regressions. Tenon does not resume lost transactions,
retry operations, or cancel arbitrary application callbacks. A lost commit acknowledgment can
leave the outcome unknown.

## Inspection and value mappings

[src/inspection/connection.ts](src/inspection/connection.ts) owns a separate `max: 1`,
`fetch_types: false` client with connection/statement/lock limits and bounded shutdown. These
inspection defaults are not runtime pool defaults. Keep [session tests](test/describe-session.test.ts).

[src/driver/types.ts](src/driver/types.ts) supplies generation and inspection mappings. Apart from
array NULL correction, conversions remain native. Compare candidate values against
[generated-value](test/generation-values.test.ts), [domain](test/generation-domains.test.ts), and
[Describe](test/describe.test.ts) tests. Check bigint/numeric, JSON, dates/infinities, byte arrays,
enums, and arrays; unverified types remain conservative and custom parsers are not inferred.

## Upgrading the pinned driver

1. Review the candidate's source and declarations against each workaround and removal condition.
2. Update package and lockfile together; remove workarounds only after testing the candidate
   without them. Keep behavioral regressions.
3. Run `npm run check`, inspect the packed artifact, and verify the PostgreSQL 16/18 CI matrix.
   Rehearse database/proxy and native listener configurations relevant to the change.
4. Update this record for the installed version and put consumer-visible changes in the changelog.
