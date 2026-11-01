# Checking query types

`tenon check` compares Tenon SQL in TypeScript source with declared input/result types and PostgreSQL
metadata. It can catch a missing result property, an int8 result declared as number, or an unsupported
bound input. It is optional; normal execution still trusts `sql<Row>` annotations.

The CLI imports the selected configuration module; the checker then reads query source without
importing those modules, evaluating input expressions, binding values, or executing application SQL. PostgreSQL still parses/analyzes each recovered statement,
which can take locks. Use a representative migrated development/test database.

## Run a check

Create [shared configuration](configuration.md), then select a project, file, or one query:

```sh
npx tenon check
npx tenon check src/users.ts
npx tenon check src/users.ts:23
npx tenon check src/users.ts:23 --project tsconfig.json --json
```

A one-based line selects the complete query containing it, including multiline templates and their
variable declaration line. A line with no query or multiple queries fails. A fragment alone is not
a complete query target.

The CLI uses `check.project`, defaulting to `tsconfig.json` beside the shared config. Use `--project`
for another TypeScript config or project directory; targets must belong to that project. Configured
paths resolve from the shared config; CLI targets and path flags resolve from the working directory.
It uses the bundled TypeScript 6 compiler and the project's imports, aliases, indexed access,
`Pick`, unions, and path mappings. `strictNullChecks` is required. Invalid configuration and compiler
errors in selected files fail the report.

Match runtime role, search path, timezone, and codecs. Session/timeout flags are the same as
[Describe](query-inspection.md#cli). CLI checks inherit the shared connection
and codec registry. Inspection-only session settings and flags override runtime startup settings.

## What gets checked

```ts
import { sql } from '@kequtech/tenon-orm';
import type { Database } from './generated-schema.js';

type Summary = Pick<Database['users']['row'], 'id' | 'email'>;
export function userQuery(id: number) {
  return sql<Summary>`SELECT id, email FROM public.users WHERE id = ${id}`;
}
```

Recognition follows Tenon's imported symbols through aliases, namespaces, barrel re-exports, and
const aliases. Unrelated functions named `sql` are ignored. Fixed-text `unsafeSql` calls with fixed
values lists are also supported. Each recoverable SQL variant goes through PostgreSQL Describe;
parameter OIDs and result columns are compared with the declared contracts.

| Finding     | Meaning                                                                     | Fails the command? |
| ----------- | --------------------------------------------------------------------------- | ------------------ |
| `mismatch`  | A definite contradiction, invalid SQL, or invalid input type                | Yes                |
| `unchecked` | SQL cannot be recovered, a limit is exceeded, or inspection cannot complete | Yes                |
| `unproven`  | Metadata cannot prove or disprove the declaration                           | No                 |

Missing required result properties fail; extra selected columns are allowed by structural types.
Each variant must fit at least one member of a declared result union. Nullability, JSON members,
literal/branded refinements, and unfamiliar decoder types may remain unproven. A broader metadata
type alone does not reject a narrower application declaration.

For enum results with unchanged default decoding, catalog labels establish exact or superset string
unions, including when unrelated Date/bigint codecs change. Narrower label subsets and branded
strings remain unproven. Custom enum decoders keep their registry representations; catalog labels
never narrow a decoder that transforms them. Disjoint string-literal declarations fail as definite
mismatches; a declaration with some matching labels remains unproven. Result nullability is outside
the check.

Input and output contracts are separate. For example, an int8 input accepts exact text, bigint, or
an explicit encoder; its default output is a string. Strings, numbers, bigint, Date, and supported
Temporal inputs use OID 0/server inference. Booleans, bytes, and recoverable `json`/`param` calls
supply the same OID hints as execution. Unions with different hints create variants. Input types do
not prove value ranges, valid Dates, or textual formats. These general limits are stated once in
readable output, rather than repeated as diagnostics for ordinary queries.

A plain object, array, or undefined input contradicts the driver's bind API. An opaque `Parameter`
is trusted, with its unknown OID reported as unproven. Describe uses server inference in that case;
dependent result comparisons and inference errors remain unproven. This does not validate the encoder.

## Responding to findings

- **Mismatch:** correct the SQL or declared contract, then recheck. For int8 output, use string under
  default codecs; for arrays/objects as inputs, choose the documented encoder.
- **Unchecked:** read the reason. An explicit shape or fixed composition may make it recoverable.
  Runtime-dependent SQL needs database tests. The command fails while unchecked sites remain in
  the selected scope; narrow the target to check supported sites separately and retain visibility
  of the remaining coverage.
- **Unproven:** retain the declaration when justified, with validation/tests for what metadata cannot
  establish. A note alone does not fail the command.

Finite optional mutation shapes are supported within the variant budget. A required, narrower
contract can reduce that budget when application validation always supplies a value:

```ts
type ActivePatch = { active: boolean };

function setActive(id: number, patch: ActivePatch) {
  return sql`UPDATE public.users SET ${sql.assignments<ActivePatch>(patch, ['active'])}
    WHERE id = ${id}`;
}
```

If omission is intended, keep optional fields. An explicit column list fixes column selection and
order; it does not make optional fields required. Empty assignments still reject at runtime, so
validate the patch if that rejection is not intended. Keep execution tests for the actual effects.

Exit 0 means no mismatch or unchecked site in the selected scope. It does not establish JSON shape,
nullability, cardinality, or every runtime branch. No query sites also fails. Independent queries
continue after an unsupported site, and a recoverable branch can expose a mismatch even when another
branch is unchecked. Diagnostics include locations, codes, parameter/column identifiers, expected
and observed types, and variant numbers. Readable output groups equivalent findings within each
query and counts those groups, preserving distinct columns, parameters and types. `--json` retains
the individual variant findings in the structured report. Ordinary scalar bindings and unknown
result nullability do not generate per-query findings.

## Supported composition

```ts
const direction = descending ? sql.fragment`DESC` : sql.fragment`ASC`;
const predicates = [sql.fragment`active = ${true}`, sql.fragment`email <> ${''}`] as const;
const query = sql<Summary>`SELECT id, email FROM public.users
  WHERE ${sql.join(predicates, 'AND')} ORDER BY email ${direction}`;
```

The checker follows inline fragments and const bindings with recoverable initializers, fixed
identifiers, fixed join lists/separators, and ternaries with recoverable branches. Both branches are
checked without evaluating the condition.

Reusing a conditional fragment preserves its branch choice. Separate ternaries using the same const
condition or an unwritten function parameter also share that choice, including simple negation.
Repeated mutable guards with unresolved correlation are unchecked. General control-flow reachability
is not inferred.

Limits are 16 complete variants per query, including parameter OID alternatives, and 32 levels of
composition references. Arbitrary fragment factories, function-body reconstruction, loops, dynamic
identifiers, mutable/escaping fragment lists, and runtime joins are unsupported. These can be valid
runtime SQL, but need database tests. Unknown source is never replaced with invented SQL.

## Object expansion

For checking, `insertValues` and `assignments` need an explicit finite shape type:

```ts
type NewUser = { email: string; active?: boolean | undefined };

function createUser(input: NewUser) {
  return sql<{ id: number }>`INSERT INTO public.users
    ${sql.insertValues<NewUser>(input, ['email', 'active'])} RETURNING id`;
}
```

For a direct object literal, the checker recovers its actual own fields and value expressions without
evaluating them. This includes shorthand properties and literals within fixed batches. A broad
generated shape therefore does not multiply variants for fields absent from the literal. An
undefined-valued expression still creates defined/omitted branches when its type permits both.

For other inputs, the shape is a trusted expansion contract. Prefer an explicit column list so
runtime and checking select the same keys/order. Without one, the declared shape is assumed to
describe exactly the expanded fields, unless the input is a recovered literal. Structural typing
cannot prove the absence of extra own keys or their order, so that assumption is unproven. Object
aliases, spreads, computed keys and accessors retain this conservative shape analysis; the checker
does not reconstruct object mutation or evaluate getters.

Optional or undefined-valued fields create bounded SQL variants. With explicit insert columns, an
absent/undefined cell becomes `DEFAULT`; with inferred columns, a field absent from every row is
omitted. Fixed batches use each row's defined fields and per-cell defaults. Assignments omit
absent/undefined fields. SQL NULL stays a bound value and is separate from omission.

The checker describes only variants that can produce SQL. Empty assignments and inferred multi-row batches
with no defined fields are rejected by the runtime helper before dispatch; the report retains an
`empty-expansion-rejected` unproven note when such an input is possible. A mutation whose every
combination rejects is unchecked. These checks do not establish that application input validation
avoids runtime rejection.

The same 16-variant limit covers optional combinations, surrounding fragments, and parameter OID
alternatives. Select fewer columns or a narrower validated shape when that limit is exceeded.
Index signatures, unresolved generic key sets, shape unions, and unknown shapes remain unsupported.
Fixed literal batches are supported; unknown batch lengths are not. Runtime helpers still accept
inferred shapes and optional fields without source checking.

For an otherwise finite shape, a constrained generic field uses its base constraint to determine
defined and omitted variants. Open generic shapes and unconstrained field values remain unchecked.

## Programmatic use and custom codecs

The checking API has a separate entry point, so ordinary queries do not load TypeScript:

```ts
import { checkQueries } from '@kequtech/tenon-orm/check';

const report = await checkQueries({
  connection,
  project: 'tsconfig.json',
  target: 'src/users.ts',
});
if (!report.ok) process.exitCode = 1;
```

The report has `ok`, `project`, `queries`, `diagnostics`, `coverage`, and available inspection
`context`. Coverage counts recognized Tenon query sites in the selected scope:

- `total`: recognized complete query sites, including unsupported ones.
- `analysed`: sites whose complete SQL variant set was recovered and inspected.
- `unchecked`: sites with unsupported structure or incomplete inspection, including a site where only
  some branches were recovered.

An analysed site can still have mismatches or unproven findings; use `ok` and diagnostics for the
result. Unrelated SQL tags are outside these counts. No recognized sites still fails with zero
coverage. JSON reports expose the same counts, so focused CI checks can retain visibility of their
scope without accepting unchecked sites as successes.

Options also accept `session`, `timeouts`, `codecs`, and `readTypes`. `connection` is a URI or pool-option
values; its `codecs` are inherited unless the explicit inspection `codecs` argument is supplied.
The programmatic API does not discover shared configuration.

For a custom codec, pass the same registry as runtime queries. A text codec may declare its output:

```ts
import { defaultCodecs } from '@kequtech/tenon-orm';

const codecs = defaultCodecs.with({
  oid: 23,
  text: {
    encode: (value: { raw: string }) => value.raw,
    decode: (raw) => ({ raw }),
    typescript: 'import("./src/types.js").DecodedInteger',
  },
});
const report = await checkQueries({ connection, project: 'tsconfig.json', codecs });
```

Here `src/types.ts` must export `DecodedInteger = { raw: string }`. Registry metadata describes
non-NULL output, including derived arrays. Type expressions compile in the application's project
without importing/executing its modules; referenced dependencies/types must be available.

Use `readTypes: { 23: 'import("./src/types.js").DecodedInteger' }` only for a decoder with no known
registry representation. It cannot replace known metadata or claim JSON members for default JSON
decoding. Expressions resolve from the tsconfig directory. A codec declaration is trusted output
metadata, not data validation.

The CLI loads the shared configuration for custom codecs; no checking script is required. An
application-owned script may still call the programmatic API with explicit options. Generated-file
freshness remains a separate `tenon generate --check` operation. For behavior tests, see
[query inspection and testing](query-inspection.md).
