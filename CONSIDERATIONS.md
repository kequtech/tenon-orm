# pgclear considerations

Tenon requires `@kequtech/pgclear` as a peer, allowing applications to update the driver independently.
The minimum supported version is 0.2.0, also resolved by the development lockfile. Public contracts belong in the
[reference](docs/reference.md); consumer changes belong in the [changelog](CHANGELOG.md).

## Driver boundary

Application queries use public `queryClassic` with finished SQL and bound values. pgclear owns
extended-protocol single-statement execution, encoding, decoding, session ownership, transaction
outcomes, savepoint recovery, and bounded resource shutdown. Tenon owns SQL composition, result
modes, query observations, and atomic affected-row guards. Whole guarded operations remain serialized
inside Tenon transactions so another write cannot enter an operation's savepoint.

Constructed pools belong to Tenon; supplied pools retain application ownership and identity. Tenon
close expires the wrapper and delegates owned shutdown. pgclear expires its callback/lease handles;
arbitrary application callbacks can continue. A lost transaction cannot resume on a fresh backend,
and a lost COMMIT response can leave an unknown outcome. Tenon does not retry.

## Describe and generation

Inspection uses public `session.describe`, with no protocol dispatch hooks or driver internals.
Catalog metadata and context are read on that same short-lived session with default codecs.
Application read representations come from the explicitly selected registry's `typescript(oid)`;
wire OIDs determine decoder selection. Domains and enum catalog information must not conceal custom
decoder overrides. Unknown custom decoder representations stay unresolved. Nullability and JSON
structure are not established by Describe. Parameter read types are not encoder input contracts.

Database declarations come from pgclear `generateDefinitions`. Tenon retains migration-lock
coordination, history-table exclusion, atomic file output, and generated-file freshness checks.
There is no separate Tenon database type mapping or renderer. See
[query checking](docs/query-checking.md) for the source-aware checker and its coverage limits.

## Upgrade validation

Review the installed driver's release notes, configuration, and representation changes. Retain
runtime, Describe, generated-type, Unicode, transaction recovery, shutdown, and packed-consumer
regressions. Run `npm run check`, inspect the packed artifact, and verify PostgreSQL 16/18 CI.
Generated-file freshness can change after a driver update without schema drift. Applications using
custom codecs must pass the same registry to generation/inspection and supply unresolved types.

Default int8 values and SQL aggregates such as count(*) use exact strings; command counts use safe
integer numbers. Plain bigint binds reject; use strings or param(text, builtin.int8). Numeric and
temporal values use strings; bytes use Uint8Array.
Arrays preserve exact scalar representations and null elements. JSON/array inputs require explicit
parameters or encoded text. The public API and generated `Database` model follow these contracts.
