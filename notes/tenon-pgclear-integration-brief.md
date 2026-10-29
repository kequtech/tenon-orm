# Tenon and Pgclear codec integration brief

Implement custom codec metadata and the agreed input conveniences while keeping PostgreSQL value
conversion in Pgclear and application type tooling in Tenon. Both agents use this file as the shared
contract. Each agent edits its own repository and preserves existing work in the other checkout.

## Responsibilities

| Responsibility                                                                                                     | Owner       |
| ------------------------------------------------------------------------------------------------------------------ | ----------- |
| Wire protocol, bind encoding, result decoding, sessions, recovery, and shutdown                                    | Pgclear     |
| Effective decoder representations, including scalar overrides and derived arrays                                   | Pgclear     |
| SQL composition, source discovery, TypeScript compilation/comparison, and diagnostics                              | Tenon       |
| Schema catalog queries, defaults/domains/identities, schema summaries, and row/insert/update rendering             | Tenon       |
| Application-facing declarations, generated-file policy, migration coordination, and column-specific mapping policy | Tenon       |
| Domain meaning, JSON validation, authorization, and application invariants                                         | Application |

A codec that returns Date, bigint, or a validated object changes actual runtime values. Its declared
representation belongs with that codec. Calling an ordinary JSON value `UserPreferences`, or a text
column `EmailAddress`, is an application contract; it is not established by a PostgreSQL OID.
Codec metadata is a trusted decoder declaration, not an additional runtime validator.

Move the existing generator implementation and relevant regressions from Pgclear into Tenon. Preserve
the useful `Database[table]['row' | 'insert' | 'update']` contract and schema summaries; do not build
a second conversion registry. Pgclear supplies conversion facts and codec representations, while
Tenon chooses conservative per-column write types and renders the declarations.

This replaces the earlier instruction to retain delegation. Pgclear's next breaking minor release
removes its published `generateDefinitions`/`GenerateOptions` exports and documents migration to
Tenon. Published Pgclear 0.2.0 remains unchanged. There is no circular compatibility wrapper or
new schema-model package.

## Shared contract

- Custom text codecs may supply `text.typescript`, an expression describing the decoded value before
  adding SQL NULL. Pgclear preserves it through registry construction and exposes the effective
  expression through `codecs.typescript(oid)` and `codecs.typescriptTypes()`.
- Registry metadata follows execution: scalar overrides affect derived built-in arrays, explicit
  array overrides win, unknown OIDs retain wire text, and unidentified custom decoders remain
  unresolved. Known `unknown` JSON output is distinct from an unidentified decoder.
- Type expressions resolve in the consuming TypeScript project. Pgclear does not load the compiler,
  resolve application modules, or infer a JSON schema. Self-contained expressions and explicit
  `import("...").Type` references are supported; referenced dependencies/types must be available.
- Plain Date, bigint, and supported native/polyfilled Temporal inputs encode as text with OID 0,
  using server inference. Invalid values still reject. Document UTC Date encoding and the distinct
  calendar, wall-time, and instant semantics of temporal values.
- Default outputs remain strings for int8 and temporal values. Date, bigint, and Temporal output
  codecs are explicit choices; runtime availability must not select different defaults. No Temporal
  runtime dependency or global polyfill is installed automatically.
- JSON and PostgreSQL arrays retain their explicit helpers. Input acceptance does not determine
  output types, and Describe does not validate input formats, ranges, nullability, or cardinality.
- Pgclear exposes the immutable selected registry as readonly `executor.codecs`. Object- and
  array-row query options accept `codecs`, for example
  `queryClassic(text, values, { codecs: defaultCodecs })`. These confirmed public conversion APIs
  select result decoding without mutating executor defaults or explicit parameter encoders.
- Tenon reads catalogs on its borrowed session and repeatable-read snapshot using default codecs,
  while rendering application columns against the session's selected registry. Preserve role,
  temporary objects, session state, migration locks, and cleanup; do not open a second connection
  merely to avoid codec overrides. Tenon imports no private driver modules.

## Work in parallel

The Pgclear agent works in `/home/kequc/projects/kequtech/pgclear`:

1. Finalize the contract above, runtime declarations, documentation, and tests. Preserve the agreed
   string defaults and explicit JSON/array rules.
2. Verify arbitrary scalar expressions and derived arrays, including function types and references
   to application types. Keep representation discovery public so Tenon needs no driver internals.
3. Prepare a fresh packed build and provide its absolute path, package version, integrity, source
   revision, and validation results. Identify any uncommitted source included in the build.
4. Expose selected-registry access and per-operation result-codec selection through public APIs.
   Test borrowed sessions, transactions, lifecycle guards, and concurrent operations; query codec
   selection must not mutate connection defaults or parameter encoders.
5. Remove the schema generator and its exports in Pgclear 0.3.0 with explicit migration notes. Tenon
   has snapshotted the existing generator for the move. Do not duplicate it or edit Tenon files.
   Transfer any remaining generation-specific edge cases as evidence for Tenon's tests.

The Tenon agent works in `/home/kequc/projects/kequtech/tenon-orm`:

1. Preserve checkpoint `aa2e127` (0.4.0 preparation using published Pgclear 0.2.0). Implement the
   boundary change after it and keep this brief outside npm output.
2. Review `.trial-dist/tenon-codec-support.patch` in the Pgclear checkout as a reference. Load all
   expressions from the selected registry, including the default registry, into the checker virtual
   module. Resolve types without executing application modules.
3. Match Date, bigint, and Temporal input types to OID 0. Retain existing boolean, byte, and explicit
   encoder hints. Keep value/range checks separate from static input-type checking.
4. Parenthesize arbitrary representations before adding SQL nullability. Emit the `PgArray` helper
   whenever it is referenced, including inside an object or other expression: the current
   prefix-only check misses `{ items: PgArray<string> }`.
5. Preserve `readTypes` for unidentified codecs and the validation against overriding known registry
   representations. Do not silently turn an unresolvable declared expression into a successful check.
6. Own generation end to end: catalog queries and summaries, defaults/domain/identity interpretation,
   conservative input policy, declaration rendering, snapshot/lock coordination, and file output.
   Use Pgclear's public registry and query capabilities and preserve the current declaration shape.
   Enum labels must not narrow a custom decoder merely because it declares a string result.
7. Update runtime, generation, Describe, checker, and packed-consumer tests plus all affected guides
   and generated fixtures. The four-file patch and its 22 checker passes do not cover the full suite.

Each agent may inspect the other repository and consume temporary packages. Keep experimental
tarball installs isolated from the release dependency graph. Exchange findings against this contract
before changing public interfaces; neither agent publishes, pushes, or commits the other's work.

## Dependency and release gate

Pgclear 0.3.0 is published. Tenon requires it through a direct runtime dependency, `^0.3.0`,
with a registry-backed lockfile. Independent compatible 0.3.x patch updates remain possible without
a Tenon release; a future breaking 0.4 requires an explicit compatibility update. No driver peer
or separate installation is required for ordinary Tenon use.

Tenon re-exports Pgclear's `json`, `param`, `builtin`, `defaultCodecs`, `createTemporalCodecs`, and
their public value/codec types. These are direct exports, with conversion still owned by Pgclear.
Application examples and generated helper imports use Tenon's entry point and its SQL tag. Native
listeners and independently created pools may still use an explicit driver dependency. Direct
installation does not hide Pgclear's SQL tag from editors; the separate tags remain incompatible
and callers alias the native one when needed.

Use a local packed build for candidate tests only. Final dependencies must use the published
version and authentic registry integrity; no local file paths or invented integrity belong in the
release graph. Pgclear 0.3.0's registry integrity matches the validated final local candidate below.
Rebuild and validate Tenon's final artifact. Publishing Tenon requires explicit user authorization.

The final local driver candidate is recorded by
`/home/kequc/projects/kequtech/pgclear/.trial-dist/pgclear-0.3.0-final.path`; its directory contains
`kequtech-pgclear-0.3.0.tgz` and `integration-manifest.json` with integrity, dirty-source provenance,
validation, and the preview comparison. The original boundary implementation passed all 215 tests
on PostgreSQL 16 and 18 against that candidate. After publication and the direct-dependency/import
changes, Tenon passed all 216 tests on PostgreSQL 16 and 18 against the real registry dependency,
including TypeScript 6/7 packed consumers. Clean `npm ci`, documentation examples, and regenerated
schema fixtures were also verified. The dependency-publication gate is resolved; Tenon remains
unpublished. Revalidate any later driver changes before releasing Tenon.

## Acceptance

- Runtime values, Describe mappings, generated rows, and query checks agree for default, custom
  scalar, derived-array, and explicit-array codecs. Custom metadata needs no duplicate `readTypes`.
- Generated and Describe declarations compile under TypeScript 6 and 7, including nullable function
  expressions, nested `PgArray` references, imported application types, and unidentified codecs.
- Tenon's owned generator preserves snapshot consistency, borrowed session state, codec-safe catalog
  reads, schema summaries, defaults/domains/identities, history-table exclusion, and output freshness.
  Pgclear's artifact contains no schema generator or dependency on Tenon.
- Date/bigint/Temporal inputs use the same OID hints in checking and execution. Include Date and
  bigint coverage on Node 24, supported polyfill coverage, native Temporal coverage where available,
  invalid-input rejection, and unchanged JSON/array encoding behavior.
- Unidentified codecs remain unproven unless mapped; known representations cannot be overridden.
  Nullability, JSON members, and application refinements retain their stated checking limits.
- Run each repository's relevant full checks. Tenon must pass runtime/recovery/generation tests,
  TypeScript 6/7 packed consumers, documentation examples/links, formatting, and artifact inspection.
  Verify PostgreSQL 16 and 18 release checks; distinguish local results from pending CI results.
