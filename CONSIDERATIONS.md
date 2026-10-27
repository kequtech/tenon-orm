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
with a driver connection ID using a marked bootstrap query and a temporary `debug` callback.
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

The warmup and connection-ID bootstrap add two queries per reservation. Ordinary unguarded queries
do not reserve a session. To remove either query, test cold acquisition, acquisition after backend
termination, concurrent reservations, and preservation of caller callbacks. Existing connection-loss
tests cover recovery; add a focused cold-start regression before claiming that broader path is covered.

These guards do not repair every driver startup failure. Application connections retain the driver's
automatic type-fetch default. Broader startup/type-fetch failures remain an upgrade consideration;
see proposed fix [#1241](https://github.com/porsager/postgres/pull/1241).

## Compiled-query execution choices

[src/connection.ts](src/connection.ts) submits detached SQL and values through native `unsafe`:

- `simple: false` enforces one statement per application query, including queries without values.
  Migration scripts deliberately use the driver's multi-statement path instead.
- `prepare: false` follows `unsafe`'s default and avoids reusing prepared column parsers captured
  before Tenon corrected a borrowed client's arrays. Inspection uses `prepare: true` for Describe
  on its separate, short-lived client. Revisit parser caching before enabling prepared execution.
- JavaScript arrays use `sql.typed(value, 0)` so SQL context establishes whether the target is a
  PostgreSQL array or JSON. The driver still serializes the value. Cast standalone parameters;
  Describe does not inspect JavaScript values and cannot reproduce value-based type inference.
- [src/query.ts](src/query.ts) rejects more than **65,533** parameters because the pinned driver
  rejects counts `>= 65534`. This is a driver-version limit, not a claim about PostgreSQL's limit;
  see the [3.4.9 execution code](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js).

Verification is in [test/driver.test.ts](test/driver.test.ts), the single-statement cases in
[test/database.test.ts](test/database.test.ts), and the composition/bind-limit cases in
[test/mutations.test.ts](test/mutations.test.ts) and [test/composition.test.ts](test/composition.test.ts).

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
