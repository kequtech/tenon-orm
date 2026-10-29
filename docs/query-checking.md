# Check authored queries

`tenon check` compares recoverable Tenon SQL with declared TypeScript contracts and the selected
PostgreSQL database. It reads source and types without importing the application, evaluating parameter
expressions, binding values, or executing application SQL. Normal query execution continues to trust
annotations and performs no additional runtime validation.

```sh
npx tenon check
npx tenon check src/users.ts
npx tenon check src/users.ts:23
npx tenon check src/users.ts:23 --project tsconfig.json --json
```

Omit the target to inspect the TypeScript project's source files. A file target checks all recognized
queries in that file. A one-based line selects the complete query containing that line, including a
multiline SQL template or its variable declaration. A line with no query or several queries fails
explicitly. A fragment alone is not a complete query target.

The checker discovers tsconfig.json from the file's directory or current working directory. Use
`--project` for another configuration or project directory. The target must belong to that project.
The checker uses the bundled TypeScript 6 compiler with the project's context, imports, aliases,
indexed access, Pick, unions, and path mappings. strictNullChecks is required. Compiler errors in
selected source files and invalid compiler configuration fail the report.

## Contracts and findings

```ts
import { sql } from '@kequtech/tenon-orm';
import type { Database } from './generated-schema.js';

type Summary = Pick<Database['users']['row'], 'id' | 'email'>;
export function userQuery(id: number) {
  return sql<Summary>`SELECT id, email FROM public.users WHERE id = ${id}`;
}
```

Recognition follows imported symbols, including aliases, namespaces, barrel re-exports, and const
aliases. A different library's function named sql is not a Tenon query. Both sql templates and
unsafeSql with fixed SQL and a fixed values list are supported.

PostgreSQL Describe parses/analyzes each complete recovered variant and returns parameter OIDs and
ordered result metadata. It can take analysis locks. Run against the intended schema, database role,
and search path; a representative development/test database is appropriate. Session and timeout
flags are the same as [Describe](query-inspection.md#cli): --role, --search-path, --time-zone,
--connect-timeout-ms, --statement-timeout-ms, and --lock-timeout-ms. DATABASE_URL is required by the CLI.

Findings have three kinds:

| Kind      | Meaning                                                                                                                                                                | Exit status   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| mismatch  | Definite contradiction, such as a missing required result property, int8 declared as number, incompatible array elements, invalid SQL, or an invalid driver input type | Failure       |
| unchecked | SQL structure cannot be recovered, a composition limit is exceeded, or inspection cannot complete                                                                      | Failure       |
| unproven  | Available evidence cannot prove or disprove the declared type                                                                                                          | Does not fail |

Declared types receive the benefit of the doubt when evidence is inconclusive. SQL result nullability,
JSON members, branded/literal refinements, and unfamiliar custom decoder types remain unproven. A
narrow declaration is not rejected merely because Describe supplies a broader representation. Each
SQL variant must fit at least one member of a declared result union. Additional selected columns are
allowed by structural result types; missing required properties fail.

Input and read contracts are separate: int8 accepts exact text or an explicit encoder and decodes
as exact strings. Boolean, bytes, and recoverable pgclear json/param calls supply the same OID hints
as execution. Unions with different hints produce variants. String/number types do not prove server
ranges or textual formats. Plain bigint, objects, arrays, Date, and undefined contradict pgclear's bind API;
use explicit parameters or encode text. A declared opaque pgclear Parameter is trusted, with its OID
reported as unproven. Describe then uses server inference; dependent result comparisons and inference
errors are unproven rather than contradictions. This is a stated limitation, not validation of the
unknown encoder.

## Responding to findings

Read each diagnostic's kind and code, then check the selected SQL and input/result declarations:

| Finding     | Action                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mismatch`  | Correct the SQL or declared contract. For an int8 column, use a string result type; for an invalid bind, use the documented encoder. Recheck after the change.                                                                  |
| `unchecked` | Inspect the reason. Recoverable SQL may need an explicit shape or fixed composition; runtime-dependent SQL needs database tests. The command fails until unchecked sites are removed from the selected scope or made checkable. |
| `unproven`  | Retain the declared contract when appropriate, with application validation and tests for the property metadata cannot establish. This note alone does not fail the command.                                                     |

For example, a generated `Database['users']['update']` makes `active` optional. An assignments
fragment can omit it, so checking that shape is unsupported even when a particular object currently
contains `active`. If a function always receives a validated boolean, declare that required shape:

```ts
type ActivePatch = { active: boolean };

function setActive(id: number, patch: ActivePatch) {
  return sql`UPDATE public.users SET ${sql.assignments<ActivePatch>(patch, ['active'])}
    WHERE id = ${id}`;
}
```

When omission is intentional, retain the optional input and test the resulting SQL and effects.
An explicit column list does not make an optional property required. Avoid assertions that merely
hide this difference. Narrow a CLI target to check supported sites independently; report the
remaining unchecked sites in the project's validation workflow.

Exit zero means no definite mismatch or unchecked site was reported in the selected scope. It does
not mean JSON members, nullability, cardinality, or every runtime branch was verified. No query sites
also fails, so an empty or incorrectly selected file cannot appear to pass.

The report includes source locations, parameter/column identifiers, expected and observed types, and
variant numbers. An unsupported site does not stop independent sites. Recoverable branches can still
expose mismatches when another branch is unchecked. The default output is readable diagnostics and
counts; --json returns the structured report.

## Supported composition

```ts
const direction = descending ? sql.fragment`DESC` : sql.fragment`ASC`;
const predicates = [sql.fragment`active = ${true}`, sql.fragment`email <> ${''}`] as const;
const query = sql<Summary>`SELECT id, email FROM public.users
  WHERE ${sql.join(predicates, 'AND')} ORDER BY email ${direction}`;
```

The checker follows inline fragments and const bindings with recoverable initializers, fixed
identifier names, fixed join lists/separators, and ternaries with recoverable branches. It checks
both branches without evaluating the condition. Reusing the same conditional fragment preserves
its branch choice. Separate ternaries using a const condition or an unwritten function parameter also share that choice,
including simple negation. Repeated mutable guards with unresolved correlation are unchecked. Branch
reachability through general application control flow is not inferred.

Each query has a fixed budget of 16 complete variants, including parameter OID alternatives, and a
32-reference composition depth limit. The checker does not evaluate arbitrary fragment factories,
walk function bodies to reconstruct returned SQL, execute loops, or accept lists that can be mutated
or escape to arbitrary application code. A runtime fragment, identifier, mutable fragment binding,
or dynamic join becomes unchecked. Unknown source is never replaced with invented SQL.

## Object expansion

For checking, insertValues and assignments require an explicit finite shape type:

```ts
type NewUser = { email: string; active: boolean };

function createUser(input: NewUser) {
  return sql<{ id: number }>`INSERT INTO public.users
    ${sql.insertValues<NewUser>(input, ['email', 'active'])} RETURNING id`;
}
```

The type is a trusted expansion contract; the checker does not read the object. Explicit column
lists give runtime and checker the same selected keys and order. Without a list, the declared
shape is assumed to describe exactly the expanded fields; TypeScript's structural typing does not
prove the absence of extra own properties or their enumeration order. This assumption is reported
as unproven. Prefer an explicit list when passing application objects.

Selected fields must be required and exclude undefined. Optional presence changes SQL through
omission or DEFAULT, so it is unchecked in this version. Unselected optional properties are fine.
Index signatures, unresolved generic key sets, unions of shapes, and unknown shapes are unchecked.
Fixed literal batches are supported; unknown batch lengths are unchecked. Runtime helpers can still
be used with inferred shapes and optional fields, but those query sites cannot be checked yet.

## Programmatic use and custom codecs

The checking API has its own entry point so ordinary execution does not load TypeScript:

```ts
import { checkQueries } from '@kequtech/tenon-orm/check';
import { defaultCodecs } from '@kequtech/pgclear';

const codecs = defaultCodecs.with({
  oid: 23,
  text: { encode: String, decode: (raw) => ({ raw }) },
});
const report = await checkQueries({
  connection,
  project: 'tsconfig.json',
  target: 'src/users.ts:23',
  codecs,
  readTypes: { 23: 'import("./src/types.js").DecodedInteger' },
});
if (!report.ok) process.exitCode = 1;
```

Pass the same registry used by execution. Known non-NULL read representations come from
codecs.typescript(oid), following wire OIDs and array overrides. Supply readTypes only for an
unidentified custom decoder; a mapping cannot replace a known registry representation or claim a
JSON member shape for default JSON decoding. Type expressions resolve from the tsconfig directory
and may import application types. Those modules are read by TypeScript and never executed.

The CLI uses default codecs. Custom registry configuration belongs in an application-owned checking
script calling this API. The application chooses that script's configuration; the checker does not
import configuration or an application entry point automatically.

pgclear owns execution, Describe, conversion knowledge, and database type generation. Tenon owns
source discovery, composition recovery, TypeScript comparison, diagnostics, and file output.
`tenon generate --check` remains a separate generated-file freshness check.
