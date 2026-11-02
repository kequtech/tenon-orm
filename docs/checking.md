# Checking SQL and schema contracts

[All guides](../README.md) · [Types](types.md) · [Reference](reference.md)

[Choose a check](#choose-a-check) · [Source checking](#source-checking) ·
[Supported composition](#supported-composition) · [Unchecked queries](#work-with-an-unchecked-query) · [Describe](#describe) ·
[Schema checkpoints](#schema-checkpoints) · [Behavior tests](#behavior-tests)

## Choose a check

| Tool                     | Establishes                                                                  | Does not establish                                               |
| ------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| TypeScript               | Call/type compatibility in your project                                      | SQL correctness or runtime data validity                         |
| `tenon generate --check` | Exact generated output matches the selected schema/codecs                    | Query projections, privileges or full schema equivalence         |
| `tenon check`            | Recoverable source SQL has no definite contradiction with declared contracts | Nullability, JSON members, authorization or every runtime branch |
| `tenon describe`         | PostgreSQL metadata for one finished statement                               | Its actual result/effects or a checked source annotation         |
| `tenon schema`           | A versioned catalog snapshot/fingerprint                                     | Complete database, security or migration-history equivalence     |
| Database workflow tests  | Observed rows, effects, rollback and permissions for exercised cases         | All production failures or capacity                              |

Use a migrated representative development/test database. Match runtime role, search path, timezone
and codecs. Checking/Describe never execute application SQL or bind its values, but PostgreSQL
parses/analyzes statements and can take locks. Importing the trusted config executes that config;
query modules themselves are only read.

## Source checking

```sh
npx tenon check
npx tenon check src/users.ts
npx tenon check src/users.ts:23 --json
npx tenon check --verbose
```

Select a project, file or one complete multiline query containing a one-based line. A fragment alone
is not a query target. `--project` overrides `check.project`; targets must belong to that project.
The checker uses bundled TypeScript 6 and the project's imports, aliases, indexed access, Pick,
unions and path mappings. It requires strictNullChecks and reports selected-file compiler errors.

| Finding   | Action                                                                                  | Fails command? |
| --------- | --------------------------------------------------------------------------------------- | -------------- |
| mismatch  | Fix a definite SQL/input/result contradiction                                           | Yes            |
| unchecked | Resolve unsupported recovery/inspection, or retain visible scoped exceptions plus tests | Yes            |
| unproven  | Validate the part metadata cannot establish                                             | No             |

### Diagnose a finding

Target one query with `npx tenon check src/posts.ts:23 --verbose`:

| Code                                 | Next step                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `result-type-mismatch`               | Compare selected columns with `sql<Row>`; a table row does not describe every projection |
| `parameter-type-mismatch`            | Check input representations; encode JSON/arrays explicitly                               |
| `dynamic-fragment` / `mutable-array` | Compare construction with the supported forms below; test retained exceptions            |
| `variant-limit`                      | Reduce independent alternatives or split materially different queries                    |
| PostgreSQL error code                | Verify the schema/role and use `tenon describe` on a finished statement                  |

Unproven findings are nonblocking; `--verbose` explains the remaining boundary to test.

No recognized sites also fails. An analysed site may still have mismatches. Each variant must fit
at least one declared result-union member; missing required properties fail, extra selected columns
are structurally allowed. Default enum labels can establish exact/superset string unions and disjoint
mismatches. Partial overlap, brands, refinements, nullability and JSON members can remain unproven.
Custom enum decoders retain their own representations rather than catalog labels.

Inputs and outputs differ: int8 accepts exact strings or bigint but defaults to string output.
Ordinary string/number/bigint/Date/Temporal binds use server inference. Boolean, bytes and recoverable
json/param calls provide the same OID hints as execution. Opaque Parameters are trusted with
unproven encoder OIDs; dependent result checks and inference failures remain unproven. Plain
objects/arrays/undefined contradict ordinary binds. Format/range validity still needs runtime checks.

The default readable report prints mismatches and unchecked findings, then summarizes nonblocking
unproven findings by reason. --verbose includes their locations/types and groups equivalent variants;
JSON keeps every individual variant diagnostic. It includes source locations, codes and expected/observed
types. Coverage counts recognized complete sites as total, analysed and unchecked. Unrelated tags
are outside the counts. Literal inline query labels are preserved from immediately enclosing Tenon
query calls; labels hidden by variables/wrappers/spreads are not guessed. Exception policy and label
uniqueness belong to the application. A recoverable branch can expose a mismatch even when another
branch is unchecked; remaining queries continue after unsupported sites.

```ts
import { checkQueries } from '@kequtech/tenon-orm/check';

const report = await checkQueries({ connection, project: 'tsconfig.json', target: 'src/users.ts' });
if (!report.ok) process.exitCode = 1;
```

This separate entry point keeps TypeScript out of ordinary runtime initialization. Programmatic
options never discover config. Connection-option codecs are inherited; an explicit codecs value
overrides the reported mappings. Use readTypes only for unidentified decoder representations, not
to override known codecs or assert JSON members. Type expressions resolve from the tsconfig directory
without executing referenced modules. Unresolvable expressions never become successful checks.

## Supported composition

Recovery follows Tenon's imported symbols through aliases, namespaces, barrels and const aliases.
It supports fixed unsafeSql text/values lists, inline/const fragments, fixed identifiers, fixed join
lists/separators and ternaries with recoverable branches. Reused conditional fragments and stable
shared conditions retain their branch choices, including simple negation. General reachability is
not inferred. Mutable guards with unresolved repeated correlation stay unchecked.

Finite helper parameters now work directly:

```ts
import { identifier, sql } from '@kequtech/tenon-orm';

export function catalogCount(table: 'pg_class' | 'pg_namespace') {
  return sql<{ total: string }>`SELECT count(*) AS total FROM ${identifier('pg_catalog', table)}`;
}
```

Every name in an immutable string-literal parameter union is quoted and inspected. Imported type
aliases and const aliases of a parameter work; reusing it keeps the same name choice. Separate
parameters describe independent alternatives. Broad strings, reassigned parameters, narrowing casts
on broad values, and property access through correlated object unions remain unchecked. When table
and column choices depend on each other, use explicit branches sharing a stable condition or
separate concrete queries. If independent name combinations produce missing-table/column errors, the query remains unchecked
with identifier-correlation-unresolved rather than reporting an invented pairing as a mismatch.

### Reuse a predicate helper

Simple helpers can take scalar or fragment arguments:

```ts
function audience(viewerId: string) {
  return sql.fragment`(is_public OR owner_id = ${viewerId})`;
}
export function visiblePosts(viewerId: string) {
  return sql<{ id: number }>`SELECT id FROM public.posts WHERE ${audience(viewerId)}`;
}
```

Function declarations and const arrows/function expressions may return one sql.fragment template,
directly or as their body's sole statement. Interpolations must be direct required parameters;
substitution preserves actual bind types, encoder hints and fragment choices across imports.
Defaults, optional/rest/destructured parameters, generics, async/generators, reassignment, captured
interpolations, extra statements and computed interpolations remain unsupported. No helper executes.

### Build an optional predicate list

```ts
export function filteredPosts(ownerId: string, status?: string) {
  const predicates = [sql.fragment`owner_id = ${ownerId}`];
  if (status) predicates.push(sql.fragment`status = ${status}`);
  return sql<{ id: number; title: string }>`SELECT id, title FROM public.posts
    WHERE ${sql.join(predicates, 'AND')}`;
}
```

A local const array may use standalone pushes, including nested if/else and multiple arguments.
Construction and joining must stay in one block before further mutations. Order and stable guard
choices are preserved; every recovered list must be nonempty. Aliases, escapes, closure access,
other mutations, spread pushes, loops and early exits remain unchecked. The budgets below still apply.

### Expand object writes

Object expansion needs an explicit finite shape:

```ts
type Patch = { email?: string; active?: boolean };
export function patchUser(id: number, patch: Patch) {
  return sql`UPDATE public.users SET ${sql.assignments<Patch>(patch, ['email', 'active'])}
    WHERE id = ${id}`;
}
```

Optional/undefined fields create bounded omitted/defined alternatives. Explicit insert columns use
DEFAULT for absent cells; assignments omit them, and null remains a bind. Direct object literals
supply actual own fields/value expressions; unknown objects use the declared shape as a trusted
expansion contract. Explicit columns avoid assumed key/order equivalence. Aliases/spreads/accessors
do not gain invented object-mutation analysis. Fixed batches are supported; unknown batch lengths,
shape unions, open generics and index signatures are not. A constrained generic field can use its
base constraint, while an unresolved shape stays unchecked.

Empty assignments and inferred multi-row default-only batches reject at runtime before SQL. Checking
retains an unproven rejection note and inspects SQL-producing variants; an entirely rejecting query
is unchecked. Keep intended omission and validate empty patches rather than casting fields required
to silence a diagnostic.

The budget is 16 complete variants per query, including optional fields and parameter OID choices,
and 32 composition references. Loops, escaping fragment lists, unrecognized list mutations, runtime joins and arbitrary
function-body analysis remain unsupported. Unknown source is never replaced with invented SQL.
Review newly analysed sites and stale exceptions when upgrading the checker, against the same schema.

## Work with an unchecked query

A multi-statement helper can be valid at runtime while remaining outside source recovery. Assume
public.posts has integer id, text title/owner_id and boolean is_public columns:

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';
type PostSummary = { id: number; title: string };

function audience(viewerId: string) {
  const predicate = sql.fragment`(is_public OR owner_id = ${viewerId})`;
  return predicate;
}

export function visiblePosts(client: QueryClient, viewerId: string) {
  return client.query(
    sql<PostSummary>`SELECT id, title FROM public.posts
    WHERE ${audience(viewerId)} ORDER BY id`,
    { returns: 'many', label: 'posts.visible' },
  );
}
```

The finding means this multi-statement body was not recovered, not that PostgreSQL rejected it.
Here, returning the template directly makes the shared helper checkable. Retain useful application
logic when it needs more statements, with a scoped exception and behavior tests. Test a public post,
the viewer's private post and another viewer's private post; assert the first two are returned and
the third is excluded. Test real rows and effects rather than SQL text.

For a deliberately retained helper, a small application script can permit one labelled site/reason
while failing unexpected or stale exceptions. After importing checkQueries from the /check entry:

```ts
import { resolve } from 'node:path';
import { checkQueries } from '@kequtech/tenon-orm/check';

const report = await checkQueries({
  connection: process.env.DATABASE_URL!,
  project: 'tsconfig.json',
});
const sites = report.queries.filter(
  (q) => q.file === resolve('src/posts.ts') && q.label === 'posts.visible',
);
const waived = new Set(
  sites.length === 1
    ? sites[0]!.diagnostics.filter((d) => d.kind === 'unchecked' && d.code === 'dynamic-fragment')
    : [],
);
// Reason: shared audience helper; covered by test/posts-visibility.test.ts.
const failures = report.diagnostics.filter((d) => d.kind !== 'unproven' && !waived.has(d));
console.log(JSON.stringify(report, null, 2)); // Preserve the actual coverage, including unchecked sites.
if (!waived.size || !report.coverage.total || failures.length) process.exitCode = 1;
```

Use this script as the CI SQL-check step for src/posts.ts while the exception exists; keep ordinary
checker targets for other query modules. Duplicate labels, a moved query,
a newly analysed helper or a changed reason invalidate it. Mismatches and project/inspection failures
remain failures. Review the exception and its behavior test when upgrading; remove it once ordinary
checking covers the site. Keep broader policy application-owned.

## Describe

```sh
npx tenon describe query.sql --search-path app,public --time-zone UTC
```

Save ordinary SQL, using `$1` placeholders if needed. The output includes parameters, columns,
PostgreSQL OIDs/types, source-column information, read representations, a conservative row declaration
and unresolved issues. It does not compare that declaration with a source annotation. Source NOT NULL
does not establish result nullability after joins/grouping. Issues include nullability-unknown,
shape-unknown, unmapped-type and duplicate-column.

```ts
import { describeQuery } from '@kequtech/tenon-orm';
const description = await describeQuery({ connection, query });
```

Pass SQL text or a finished statement with OID hints. Values are never bound or executed. Inspection
uses a separate short-lived session, not the callback transaction's temporary objects or uncommitted
state. It applies read-only analysis, bounded connect/statement/lock waits and explicit session
overrides; inspect the returned context to verify role, paths, timezone and limits. Connection options
and codecs follow [configuration](database.md#configuration); [reference flags](reference.md#commands)
list defaults. A Describe success does not prove valid inputs, execution grants, cardinality or effects.

## Schema checkpoints

```sh
npx tenon schema --namespace app
```

`inspectSchema({ connection, namespace? })` returns formatVersion 1, postgresMajor, namespace,
tables, enums, domains, sequences and fingerprint. Namespace selection matches generation. It
writes no files or database state. Reads use default codecs on one borrowed session in a read-only
repeatable-read transaction with the shared migration lock. Temporary deparser/session settings
are restored, and borrowed pools remain owned by the application.

Included metadata covers ordinary/partitioned tables and attached partitions, column types/order,
nullability/default/generated/identity/collation, inheritance/partition definitions, named constraints
and indexes (including validity/readiness), ordered enum labels, domains and sequence declarations
with owned-column associations. Sequence integer settings are exact strings; positions and row data
are excluded, as is the namespace's __tenon_migrations table. Names use C sorting; meaningful catalog
orders are preserved. See exported SchemaSnapshot types for individual fields and PostgreSQL kind codes.

The fingerprint is `tenon-schema-v1:sha256:<hex>`, hashing canonical metadata JSON with sorted object
keys and preserved array order. It includes namespace and PostgreSQL major, excludes OIDs/connection
values and pins stable formatting settings. Codec, generator and prose changes do not affect it.
Fresh replay in the same namespace/major reproduces it. Changed fingerprint inputs require a new
format version; PostgreSQL deparsing can change even in patches, so review upgrade differences.

Version 1 excludes functions, privileges/owners, RLS, triggers, rules, views/materialized views,
foreign tables, extension/composite/range and collation definitions, external definitions and table
storage settings. Index storage clauses emitted in index definitions are included. Qualified external
references remain in SQL definitions. Uncoordinated external DDL is outside Tenon's lock contract.
This is a checkpoint component, not full equivalence. [Baseline adoption](database.md#adopt-an-existing-schema)
requires separately reviewed function/security/history checks and a frozen trusted replay reference.

## Behavior tests

Execute the same query functions used by the application against dedicated test storage. Assert
actual rows and effects, including null/omitted fields, authorization, rollback, meaningful composition
alternatives and retries/reconciliation where applicable. Preserve unexpected findings. Neither SQL
string matching nor tests for words in documentation establish database behavior.
