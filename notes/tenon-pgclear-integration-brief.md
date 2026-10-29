# Tenon and Pgclear codec integration brief

Implement custom codec metadata and the agreed input conveniences while keeping PostgreSQL value
conversion in Pgclear and application type tooling in Tenon. Both agents use this file as the shared
contract. Each agent edits its own repository and preserves existing work in the other checkout.

## Responsibilities

| Responsibility                                                                                                                  | Owner       |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Wire protocol, bind encoding, result decoding, sessions, recovery, and shutdown                                                 | Pgclear     |
| Effective decoder representations, including scalar overrides and derived arrays                                                | Pgclear     |
| SQL composition, source discovery, TypeScript compilation/comparison, and diagnostics                                           | Tenon       |
| Application-facing schema/query declarations, generated-file policy, migration coordination, and column-specific mapping policy | Tenon       |
| Domain meaning, JSON validation, authorization, and application invariants                                                      | Application |

A codec that returns Date, bigint, or a validated object changes actual runtime values. Its declared
representation belongs with that codec. Calling an ordinary JSON value `UserPreferences`, or a text
column `EmailAddress`, is an application contract; it is not established by a PostgreSQL OID.
Codec metadata is a trusted decoder declaration, not an additional runtime validator.

Tenon currently delegates schema rendering to Pgclear `generateDefinitions`. Keep that implementation
for this integration: it avoids duplicate conversion tables. Pgclear's helper remains reusable
storage tooling; application mappings and TypeScript project configuration must not grow into it.
Moving the renderer into Tenon is a separate change if application generation needs demonstrate it.

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

## Work in parallel

The Pgclear agent works in `/home/kequc/projects/kequtech/pgclear`:

1. Finalize the contract above, declarations, codec/generation behavior, documentation, and tests.
   Preserve the agreed string defaults and explicit JSON/array rules.
2. Verify arbitrary scalar expressions and derived arrays, including function types and references
   to application types. Keep representation discovery public so Tenon needs no driver internals.
3. Prepare a fresh packed build and provide its absolute path, package version, integrity, source
   revision, and validation results. Identify any uncommitted source included in the build.
4. Select a distinct next release version. Published 0.2.0 lacks the new APIs and must not be
   replaced. Do not edit Tenon files or apply the trial patch to its checkout.

The Tenon agent works in `/home/kequc/projects/kequtech/tenon-orm`:

1. Commit the current 0.4.0 preparation as a reproducible checkpoint using published Pgclear 0.2.0.
   It does not yet include the unpublished codec/input changes. Keep this brief outside npm output.
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
6. Update runtime, generation, Describe, checker, and packed-consumer tests plus all affected guides
   and generated fixtures. The four-file patch and its 22 checker passes do not cover the full suite.

Each agent may inspect the other repository and consume temporary packages. Keep experimental
tarball installs isolated from the release dependency graph. Exchange findings against this contract
before changing public interfaces; neither agent publishes, pushes, or commits the other's work.

## Dependency and release gate

The current Tenon checkpoint requires published Pgclear 0.2.0. The next integration must require the
distinct Pgclear release that contains `TemporalInput`, codec metadata, and `typescriptTypes()`.
Optional chaining on the new method does not make an unconditional reference to a missing exported
type compatible with 0.2.0.

Use a local packed build for integration tests, then update Tenon's development dependency, minimum
peer, and lockfile to the real published version. Do not ship a local file dependency, invented
registry integrity, or a peer range admitting drivers without the required API. The checkpoint's
0.4.0 tarball is not evidence for the later integration; rebuild and validate its final artifact.
Publishing either package requires explicit user authorization.

## Acceptance

- Runtime values, Describe mappings, generated rows, and query checks agree for default, custom
  scalar, derived-array, and explicit-array codecs. Custom metadata needs no duplicate `readTypes`.
- Generated and Describe declarations compile under TypeScript 6 and 7, including nullable function
  expressions, nested `PgArray` references, imported application types, and unidentified codecs.
- Date/bigint/Temporal inputs use the same OID hints in checking and execution. Include Date and
  bigint coverage on Node 24, supported polyfill coverage, native Temporal coverage where available,
  invalid-input rejection, and unchanged JSON/array encoding behavior.
- Unidentified codecs remain unproven unless mapped; known representations cannot be overridden.
  Nullability, JSON members, and application refinements retain their stated checking limits.
- Run each repository's relevant full checks. Tenon must pass runtime/recovery/generation tests,
  TypeScript 6/7 packed consumers, documentation examples/links, formatting, and artifact inspection.
  Verify PostgreSQL 16 and 18 release checks; distinguish local results from pending CI results.
