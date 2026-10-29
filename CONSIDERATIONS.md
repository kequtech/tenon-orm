# Pgclear considerations

Tenon includes `@kequtech/pgclear` as a runtime dependency. The supported driver line is 0.3.x;
applications can update its patch releases independently. Public contracts belong in the [reference](docs/reference.md);
consumer changes belong in the [changelog](CHANGELOG.md). The shared
[integration brief](notes/tenon-pgclear-integration-brief.md) records the responsibility boundary.

## Driver boundary

Application queries use public `queryClassic` with finished SQL and bound values. Pgclear owns
extended-protocol single-statement execution, encoding, decoding, session ownership, transaction
outcomes, savepoint recovery, and bounded resource shutdown. Tenon owns SQL composition, result
modes, query observations, and atomic affected-row guards. Whole guarded operations remain serialized
inside Tenon transactions so another write cannot enter an operation's savepoint.

Constructed pools belong to Tenon; supplied pools retain application ownership and identity. Tenon
close expires the wrapper and delegates owned shutdown. Pgclear expires its callback/lease handles;
arbitrary application callbacks can continue. A lost transaction cannot resume on a fresh backend,
and a lost COMMIT response can leave an unknown outcome. Tenon does not retry.

## Representations and application types

The selected pgclear registry owns facts about decoder output. `typescript(oid)` reports its known
non-NULL representation; `typescriptTypes()` exposes the known expressions for downstream compilation.
Custom text codecs can declare `text.typescript`. Tenon resolves those expressions in the consuming
TypeScript project without executing application modules. Scalar overrides affect derived built-in
arrays, and explicit array overrides win. A known unknown JSON representation is distinct from an
unidentified decoder.

Codec metadata is a trusted declaration of conversion behavior, not a runtime validator. Application
column meanings and JSON schemas remain application contracts. Wire OIDs determine execution's
selected decoder; catalog domains or enum choices must not conceal a custom decoder. Source checking
retains `readTypes` only for unidentified representations and rejects attempts to override known
metadata. Describe does not establish result nullability, JSON members, or cardinality, and input
acceptance is separate from read mapping.

## Describe and generation

Inspection uses public `session.describe`, with no protocol dispatch hooks or driver internals.
Catalog metadata and context are read on that same short-lived session with default codecs.

Tenon owns schema catalog queries, defaults/domain/identity interpretation, schema summaries, and
`Database[table]['row' | 'insert' | 'update']` rendering. It obtains conversion representations from
pgclear rather than maintaining a second decoder registry. Tenon also owns the migration advisory
lock, history-table exclusion, generated-file policy, atomic output, and freshness checks.

Generation reads catalogs in a repeatable-read snapshot on its borrowed session. Public driver
registry access and per-operation result-codec selection keep metadata decoding on default codecs
while application row types follow the configured registry. This preserves role/session context and
avoids opening another connection merely to bypass custom codecs. Pgclear does not resolve
application imports or render database declarations. See [query checking](docs/query-checking.md)
for the source-aware checker and its coverage limits.

## Upgrade validation

Review the installed driver's release notes, configuration, and representation changes. Retain
runtime, Describe, generated-type, Unicode, transaction recovery, shutdown, and packed-consumer
regressions. Run `npm run check`, inspect the packed artifact, and verify PostgreSQL 16/18 CI.
Generated-file freshness can change after a driver or generator update without schema drift.
Applications using custom codecs must pass the same registry to generation/inspection and provide
declarations for application types referenced by codec metadata.

Default int8 values and SQL aggregates such as count(*) use exact strings; command counts use safe
integer numbers. Plain bigint, Date, and supported native/polyfilled Temporal inputs encode as text
with OID 0 and server inference. Date inputs use UTC. Date, bigint, and Temporal output codecs are
opt-in; defaults do not change according to runtime availability. Numeric and temporal defaults use
strings; bytes use Uint8Array. Arrays preserve exact scalar representations and null elements.
JSON/array inputs retain explicit parameters or encoded text, and JSON encoding still rejects bigint.
