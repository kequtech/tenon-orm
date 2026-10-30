# Pgclear integration

Tenon includes `@kequtech/pgclear` as a runtime dependency, currently supporting 0.3.x. This document
explains the library boundary for maintenance. Application contracts belong in the
[reference](docs/reference.md), value mappings in [schema types](docs/schema-types.md), and
consumer-visible changes in the [changelog](CHANGELOG.md). The
[integration brief](notes/tenon-pgclear-integration-brief.md) records the original agreement.

## Execution and ownership

Tenon sends finished SQL and bound values through public `queryClassic`. Pgclear owns
extended-protocol execution, encoding/decoding, session ownership, transaction outcomes, savepoint
recovery, and bounded shutdown. Tenon owns composition, result modes, query observations, and atomic
affected-row guards.

Whole guarded operations are serialized inside callback transactions so another write cannot enter
the operation's savepoint. A guard failure rolls back before rejection. This policy belongs above
the driver rather than inside its protocol machinery.

Tenon owns constructed pools. Supplied pools retain application ownership and identity. Closing
Tenon expires the wrapper and delegates owned resource shutdown; arbitrary JavaScript callbacks may
continue. Pgclear expires its callback/lease handles. A lost transaction cannot resume on a fresh
backend, and a lost COMMIT response may leave an unknown outcome. Tenon does not retry.

## Representations

The selected registry owns decoder-output facts. `typescript(oid)` reports its known non-NULL
representation; `typescriptTypes()` exposes known expressions for downstream compilation. Custom
text codecs can declare `text.typescript`. Scalar overrides affect derived built-in arrays; explicit
array overrides win. A known unknown JSON representation differs from an unidentified decoder.

Tenon consumes these expressions instead of maintaining another decoder registry. The source checker
resolves them in the application's TypeScript project without executing modules. `readTypes` is a
fallback only for unidentified decoder representations; it cannot replace known metadata.

Codec metadata is a trusted description of conversion behavior, not data validation. Application
column meanings and JSON members remain application contracts. Wire OIDs select execution's decoder;
catalog domain/enum interpretation must not conceal a custom decoder. Describe does not establish
result nullability, JSON members, or cardinality. Input encoding is separate from output decoding.

Default int8 and `count(*)` outputs use exact strings; command counts use safe integer numbers.
Numeric/temporal defaults use strings, bytes use Uint8Array, and arrays retain scalar representations
and null elements. Plain bigint, Date, and supported native/polyfilled Temporal inputs use text with
OID 0/server inference; Date uses UTC. Output conversions are explicit. JSON/array inputs keep explicit
encoding, and JSON encoding still rejects bigint.

## Inspection and generation

Inspection uses public `session.describe`, without protocol hooks or driver internals. Its own catalog
metadata and context use default codecs on that same short-lived session. Reported application read
representations follow the selected registry.

Tenon owns schema catalog queries, defaults/domains/identities, summaries, and
`Database[table]['row' | 'insert' | 'update']` rendering. It also owns the migration advisory lock,
history-table exclusion, file policy, atomic replacement, and freshness checking.

The CLI owns generation output/freshness checks and loads shared `tenon.config.ts` connection values for generation, inspection, checking, and
migrations. Configuration modules export values without opening pools.
`generateDefinitions` provides source text without file output.

Generation reads catalogs in a repeatable-read snapshot on a borrowed session. Per-operation result
codec selection keeps metadata decoding on defaults while declarations follow the configured
registry. This preserves role/session context without a second connection merely to bypass custom
codecs. Pgclear does not resolve application imports or render schema declarations.

The decoder override on catalog queries is internal. Application queries, including callback
transactions, retain database-wide codecs; Tenon exposes no per-query override.

## Upgrade checks

Review the installed driver's changelog, configuration, and representation changes. Retain runtime,
Describe, generation, Unicode, recovery, shutdown, and packed-consumer regressions. Run
`npm run check`, inspect the packed artifact, and verify PostgreSQL 16/18 CI. See
[CONTRIBUTING.md](CONTRIBUTING.md#test-an-unpublished-driver-candidate) for candidate artifacts.

After a registry or driver change, regenerate/review types. CLI tools share the configured registry;
programmatic inspection/checking inherit `connection.codecs` or accept an explicit registry. Referenced application types must resolve in each compilation context. A
freshness diff can reflect generator/driver changes without schema drift; generated text is not a
version-stable schema fingerprint.
