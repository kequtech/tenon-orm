# pgclear review and support for typed Tenon queries

Feedback for the pgclear author, 28 October 2026. This covers the M4 consumer review and a proposed
typed-query workflow for Tenon. The workflow and API additions below are proposals, not implemented
features or a request to begin M5 automatically.

Historical note: the value contracts below describe the reviewed candidate. Pgclear 0.2.0 now uses
exact strings for int8 reads and safe integer numbers for command counts, and rejects plain bigint
binds. See the [current reference](../docs/reference.md) for Tenon's supported contracts. This archived
investigation is retained for repository history and is not part of the published consumer docs.

pgclear has credible potential to replace Tenon's pg dependency. Explicit session ownership, native
Describe, bounded shutdown, and deliberate transaction outcomes simplify Tenon's driver boundary.
Adoption still requires an intentional public API migration and broader consumer validation. Query
type generation is a useful extension of Describe; it does not require pgclear to implement a SQL
parser or generate TypeScript itself.

## Review findings and current status

The independent review used pgclear revision `7314085` and Tenon 0.3.1 at `4d6cb97`. In an isolated
copy on Node 24.4.1 and PostgreSQL 16.15, it reproduced the trial results:

- The original pg baseline passed all 180 tests.
- The packed candidate passed all 15 consumer contract cases. The baseline passed the 13 shared
  cases, with two candidate-only cases skipped.
- pgclear passed formatting, strict types, 49 database-independent tests, and 44 integration tests.

Additional comparisons against pg exposed two priority-one correctness defects despite those passes.

### Leading U+FEFF was removed from values and names

```sql
SELECT chr(65279) || 'hello' AS value;
```

The expected string is `"\uFEFFhello"`; pgclear returned `"hello"`. A column named `"\uFEFFvalue"`
also became `"value"`. Both `src/codecs/index.ts` and `src/protocol/messages.ts` constructed a
TextDecoder without `ignoreBOM: true`. A PostgreSQL field is data, so an initial U+FEFF must survive.
Node documents that the default removes this character; setting `ignoreBOM: true` preserves it.
See the [Node TextDecoder contract](https://github.com/nodejs/node/blob/v24.4.1/doc/api/util.md#new-textdecoderencoding-options).

### Array decoding trimmed valid Unicode data

```sql
SELECT ARRAY[chr(160) || 'hello', 'hello' || chr(160)] AS value;
```

The expected array is `["\u00A0hello", "hello\u00A0"]`; pgclear returned `["hello", "hello"]`.
EM SPACE and U+FEFF were also lost. The array parser used JavaScript's `\s` for skipping and trimming,
which treats more Unicode characters as syntax whitespace than PostgreSQL does.

On rereading the working tree for this note, both fixes and additional regressions are present:
the decoders preserve U+FEFF, and array syntax whitespace uses an explicit ASCII predicate. The
author's updated documentation reports 100 passing driver tests and 17 passing candidate cases,
including comparisons with server JSON and PostgreSQL array input. Those newer counts are reported
by the author; the independent review did not rerun that revised suite. These findings should remain
regressions, rather than be described as still-unfixed defects.

### Adoption implications

The adapter usefully removes Tenon's custom Describe dispatch and much of its connection-loss,
shutdown, transaction, and savepoint plumbing. Whole guarded operations remain serialized in Tenon,
while pgclear owns the physical session and recovery. That is a sensible responsibility boundary.

The candidate deliberately changes counts to bigint, temporal values to text, bytes to Uint8Array,
numeric arrays to exact strings, result arrays to readonly arrays, and JSON/array inputs to explicit
parameters. Its native pool API also changes. These choices are reasonable, but need corresponding
Tenon documentation, generated types, public examples, and behavioral regressions.

The 180 baseline passes and 15 original candidate passes establish different things. They do not
establish that all applicable Tenon regressions have been ported. Complete the outstanding M4
consumer and PostgreSQL 16/18 gates before treating replacement as validated. Deployment compatibility
and performance remain separate work; M5's prepared statements, streaming, and COPY do not substitute
for those checks. Owning a driver also adds protocol and authentication maintenance, even when the
consumer adapter becomes smaller.

## What Tenon already knows about a query

Tenon's existing `describeQuery()` returns parameter types, result columns, source metadata where
available, diagnostics, and a conservative TypeScript `rowType`. Its limitation is the missing
connection between that inspection result and the application's compile-time return type.
`sql<MyRow>` is still a caller-supplied assertion; inspection does not verify that annotation.

PostgreSQL Describe supplies output names and database type identifiers, including for expressions
and aggregates. It does not supply result nullability, JSON member shapes, or row cardinality.
These limits follow from the
[RowDescription fields](https://www.postgresql.org/docs/18/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-ROWDESCRIPTION).
Statement Describe can obtain parameter and result metadata before Bind or Execute; see
[extended query flow](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY).

For example, a NOT NULL table column can become null through an outer join. Catalog constraints are
useful source information, not proof of result nullability. Likewise, knowing that a field is jsonb
does not establish a TypeScript object shape. Sampling execution results cannot prove either property.

## Proposed first workflow

Use an explicit folder of authored SQL files. The generator discovers those files, describes each
statement against the selected schema, and writes a separate generated TypeScript module. It does
not need to find every SQL template in arbitrary application code or insert annotations into
handwritten files.

For example, the developer authors `queries/active-users.sql`:

```sql
SELECT id, email
FROM app.users
WHERE active = $1::boolean
ORDER BY id;
```

Assume `id` is int4 and `email` is text. A proposed command could be:

```sh
# Proposed CLI; this command does not exist yet.
tenon generate-queries --input queries --output src/generated/queries.ts
```

The generated module embeds the exact described SQL and exports a typed wrapper. The following
illustrates the output using Tenon's existing public calling convention:

```ts
// Generated file. Edit queries/active-users.sql, then regenerate.
import { unsafeSql, type QueryClient } from '@kequtech/tenon-orm';

export type ActiveUsersRow = {
  id: number | null;
  email: string | null;
};

const text = `SELECT id, email
FROM app.users
WHERE active = $1::boolean
ORDER BY id;`;

export function activeUsers(client: QueryClient, values: readonly [boolean | null]) {
  return client.query(unsafeSql<ActiveUsersRow>(text, values), { returns: 'many' });
}
```

The application imports `activeUsers` and calls `await activeUsers(db, [true])`. Editor completion
and TypeScript checking now follow the generated result type. There is no runtime database call to
discover TypeScript types, and deployment does not need the generation tool or the original SQL files
when the SQL is embedded.

The example conservatively includes null in both output fields. Its boolean input is a deliberately
selected binding policy, not a deduction that PostgreSQL rejects other encodings. Describe reports
parameter OIDs, not JavaScript input types or parameter names. Named arguments would require explicit
names in an authored definition or supported SQL annotation.

The generator should run after migrations against a representative development/test schema, using
the intended role and search path. It must not execute the inspected application statements. In CI,
apply migrations to the test database and run a proposed `--check` mode that regenerates in memory and
fails on stale output. Commit generated output for review. Record the SQL and mapping-policy version
needed to reproduce it; credentials and local paths do not belong in generated files. Database-local
OIDs should not become portable runtime assumptions.

Separate SQL files are a small initial scope. Existing composed Tenon queries remain available.
A later explicit registry of side-effect-free query definitions could support TypeScript composition
without importing the application entry point. Runtime-dependent projections, table names, or SQL
branches need registered variants, a proven invariant result shape, or manual typing. One described
variant cannot verify every branch.

## What pgclear should expose

Most protocol requirements are already present. The main additional need is a public, reliable way
to identify how the selected registry decodes a described field.

| Driver capability                           | Current position                         | Requirement for generation                                                                                                                   |
| ------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Describe without executing the statement    | Implemented                              | Preserve parameter OIDs and ordered fields, including zero-row results and commands returning no columns.                                    |
| Field metadata                              | Implemented                              | Preserve exact names, wire type OID, type modifier, table OID, and attribute number. Do not invent nullability.                              |
| Explicit parameter type hints               | Implemented                              | Retain hints for SQL whose parameter types cannot be inferred. No execution values should be required.                                       |
| Describe on an owned session or transaction | Implemented                              | Permit Describe and catalog reads in the same session, with the relevant role, search path, temporary objects, and transaction visibility.   |
| Deadlines and cleanup                       | Implemented                              | Retain bounded completion, abort/loss behavior, and cleanup for successful and failed descriptions.                                          |
| Decoder representation metadata             | No public introspection in CodecRegistry | Allow tooling to resolve the actual selected read representation without inspecting driver internals or invoking a decoder on invented data. |

For the final row, prefer a small representation descriptor over TypeScript source strings in the
driver. It could express scalar kinds such as string, number, bigint, boolean, bytes, parsed JSON,
and recursive arrays, plus an explicit custom/unknown result. Tenon would render those descriptors
as TypeScript. The exact API name and descriptor shape should follow a demonstrated consumer need.

Resolution must follow the same rules as real decoding: scalar overrides affect derived built-in
arrays, explicit array overrides win, raw JSON differs from parsed JSON, and unknown extension array
OIDs remain wire text unless a decoder changes that. A SQL array declaration alone is not evidence
that the driver returns a JavaScript array. Fields carry wire type identities; catalog domain or enum
information must not override the actual decoder's behavior.

A custom decoder's TypeScript return type cannot be recovered from its JavaScript function or an
erased `Codec<T>` generic. Applications should provide an explicit generation mapping, including any
importable type reference, when selecting custom codecs. Otherwise generation must surface an
unresolved type, rather than silently assume the default registry. Reuse the runtime registry in
generation and make stale mapping configuration detectable in CI. This metadata describes the
decoder contract; it is not runtime validation of arbitrary decoder output.

Keep parameter generation separate from read mapping. An int8 read is bigint, while valid parameter
encodings can include text, bigint, and explicit codec parameters. Tenon can initially support a
documented narrow input policy or explicit application declarations. It must not derive write types
by copying read types.

pgclear does not need to own SQL discovery, query registration, catalog interpretation, TypeScript
rendering, generated wrappers, nullability analysis, or application JSON schemas. Tenon should own
those. Ordinary public catalog queries are sufficient; a new driver catalog API is unnecessary for
the first implementation.

## Acceptance cases for the first implementation

- A query with no matching rows still gets its output types from metadata. Describing an UPDATE
  RETURNING or a nextval expression leaves the target data or sequence unchanged.
- Generated wrappers execute the same SQL that was described and work with both database and
  transaction clients. Changing authored SQL or the relevant schema makes the generation check fail.
- Generated declarations compile under supported TypeScript versions and reject incorrect result
  usage and inputs under the chosen binding policy.
- Results cover bigint counts, exact numeric arrays, temporal text, bytes, SQL NULL, parsed/raw JSON,
  enum/domain behavior, unknown extension arrays, scalar overrides, and explicit array overrides.
- Outer-join fields remain nullable without supporting analysis. JSON shapes remain unknown without
  a declared schema. Duplicate object-column names fail generation with an actionable diagnostic.
- Unicode names and values survive both metadata inspection and execution. Generated TypeScript
  quotes and escapes field names and embedded SQL correctly.
- Missing objects, ambiguous parameters, permission/context failures, timeout, and disconnect produce
  useful diagnostics and leave no live inspection resources. Failed generation does not replace a
  previously valid generated file with partial output.

The practical next step is a small Tenon generator using existing Describe plus a minimal, tested
decoder-mapping contract. It can provide useful automatic result types before any general SQL
analysis exists. M5 preparation can reuse the same description metadata, but named prepared handles
are not a prerequisite for this workflow.
