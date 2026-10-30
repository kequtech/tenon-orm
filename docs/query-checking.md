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

Input and output contracts are separate. For example, an int8 input accepts exact text, bigint, or
an explicit encoder; its default output is a string. Strings, numbers, bigint, Date, and supported
Temporal inputs use OID 0/server inference. Booleans, bytes, and recoverable `json`/`param` calls
supply the same OID hints as execution. Unions with different hints create variants. Input types do
not prove value ranges, valid Dates, or textual formats.

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

For example, generated update fields are optional and can disappear from SQL. If application
validation always supplies a boolean, declare that required contract:

```ts
type ActivePatch = { active: boolean };

function setActive(id: number, patch: ActivePatch) {
  return sql`UPDATE public.users SET ${sql.assignments<ActivePatch>(patch, ['active'])}
    WHERE id = ${id}`;
}
```

If omission is intended, keep optional fields and test the SQL/effects. An explicit column list does
not make optional fields required. Avoid assertions that merely hide this distinction.

Exit 0 means no mismatch or unchecked site in the selected scope. It does not establish JSON shape,
nullability, cardinality, or every runtime branch. No query sites also fails. Independent queries
continue after an unsupported site, and a recoverable branch can expose a mismatch even when another
branch is unchecked. Diagnostics include locations, codes, parameter/column identifiers, expected
and observed types, and variant numbers. `--json` returns the structured report.

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
type NewUser = { email: string; active: boolean };

function createUser(input: NewUser) {
  return sql<{ id: number }>`INSERT INTO public.users
    ${sql.insertValues<NewUser>(input, ['email', 'active'])} RETURNING id`;
}
```

The shape is a trusted expansion contract; the checker does not read the object. Prefer an explicit
column list so runtime and checking select the same keys/order. Without one, the declared shape is
assumed to describe exactly the expanded fields. Structural typing cannot prove the absence of
extra own keys or their order, so that assumption is unproven.

Selected fields must be required and exclude undefined. Optional presence changes the SQL through
omission or DEFAULT and is unchecked. Unselected optional properties are fine. Index signatures,
unresolved generic key sets, shape unions, and unknown shapes are unsupported. Fixed literal batches
are supported; unknown batch lengths are not. Runtime helpers still accept inferred shapes and
optional fields.

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

The report has `ok`, `project`, `queries`, `diagnostics`, and available inspection `context`. Options
also accept `session`, `timeouts`, `codecs`, and `readTypes`. `connection` is a URI or pool-option
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
