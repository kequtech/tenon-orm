# Agent guide

Use this as a short workflow for changing an existing Tenon application. For first setup, follow
[Getting started](human-guide.md). Exact contracts are in the [reference](reference.md).

## Read the project first

Inspect `tenon.config.ts` (or its JavaScript equivalent), the database module, nearby query
functions, migration runner, generated types, and check commands. Reuse the application's package manager, connection configuration, namespace, and
conventions. Read the docs shipped with the installed Tenon version.

For an upgrade, find the previous resolved version in the lockfile and read the
[changelog](../CHANGELOG.md) through the target version and follow its API and driver upgrade
instructions. Check both Tenon and pgclear versions before changing native
calls or representations.

## Write a query function

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';
import type { Database } from './generated-schema.js';

type Summary = Pick<Database['users']['row'], 'id' | 'email'>;

export function userById(client: QueryClient, { id }: { id: number }) {
  return client.query(sql<Summary>`SELECT id, email FROM public.users WHERE id = ${id}`, {
    returns: 'oneOrNone',
  });
}
```

Use a `QueryClient` parameter when callers may pass `db` or `tx`. Keep SQL and execution options
together. Qualify table names or follow the configured runtime search path.

- Bind values without quotes. Do not mix manual `$n` placeholders into templates.
- Declare the actual projection with `sql<Row>`. Generated table rows do not describe arbitrary
  joins/aggregates, and annotations do not validate runtime output.
- Choose `many`, `oneOrNone`, `one`, or default `native` deliberately. Modes add no SQL limits.
  A cardinality error alone does not undo an autocommitted write.
- Use approved `identifier(...)` names and fixed fragments for SQL syntax. Keep mandatory
  authorization predicates in every branch.
- Use fragments for real reuse/composition. Runtime loops work but may remain unchecked by the
  optional checker. See [writing queries](sql.md).

## Preserve representations and validate inputs

Bigint/bigserial and `count(*)` read as exact strings by default; command `rowCount` is a number or
null. Decimals and temporal values default to strings, bytes to Uint8Array, and JSON to unknown.
Built-in arrays preserve scalar representations and null elements.

Plain bigint, valid Date, and supported Temporal inputs are accepted; inputs do not change output
decoders. Plain arrays/objects require `json`, `param`, or encoded text. Direct undefined rejects.
JSON encoding still rejects bigint. Import parameter/codec helpers from Tenon.

Keep the registry in shared `connection.codecs` so queries and CLI tools agree. Programmatic
inspection/checking inherit codecs from connection-option values; pass the registry explicitly
when using a URI. Retain application validation, authorization, domain conversion, and retry
policy. See [schema types and values](schema-types.md).

## Change data deliberately

Use `sql.insertValues` and `sql.assignments` for object fields while keeping table, predicates,
expressions, conflicts, and `RETURNING` in SQL. Apply generated insert/update types and narrow
editable fields with `Pick`.

Missing/undefined insert fields use defaults; assignment fields are omitted; null remains null.
Empty batches and assignments reject. Explicit column lists select/order fields and can discard
required inputs. Batch below the complete query's 65,535-parameter limit. See [writing data](mutations.md).

For work that commits together, use `db.transaction` and await every operation through `tx`. A
callback client expires when it finishes; root/native pool queries do not join it. Tenon owns
transaction boundaries and provides no automatic retries.

Use `affectedRows: { exact: n }` or `{ max: n }` for write bounds. A root guard uses a transaction;
a callback guard uses a savepoint. A rejected guarded operation rolls back before throwing, so a
caught guard failure permits continued work. An unguarded server error normally aborts the
transaction. Counts exclude additional trigger/cascade/CTE effects. A lost commit response can
leave an unknown outcome. See [transactions](reference.md#transactions-guarded-writes-and-errors).

## Make schema changes

Keep an existing migration runner. With Tenon's runner, create a new numbered SQL pair, fill both
files or omit an irreversible down file, and apply it. Never change applied SQL; checksums include
both directions. Each file commits separately. Use direct or session pooling for tooling advisory
locks. See [migrations](migrations.md).

After migrations commit, run `tenon generate` with the project's
[shared configuration](configuration.md). Review the diff and commit migrations with exact
generated output. Keep handwritten aliases separate and generated files out of formatting. In CI,
migrate the test database and run `tenon generate --check` without first regenerating. Production
consumes committed declarations.

## Verify the changed workflow

Run the project's typecheck and database tests for actual rows, effects, permissions, and rollback.
Use `tenon check` for source contracts and `tenon describe` for finished SQL metadata when useful.
See [validation tools](reference.md#choosing-a-validation-tool).

The checker fails on definite mismatches and unchecked sites; unproven properties remain notes.
Fixed composition is supported within bounded variants. Object expansion needs an explicit finite
shape with required, defined selected fields; optional generated patches may be unchecked. Keep
intentional omission behavior and test it. Narrow to required fields only when application validation
establishes that contract; do not cast merely to silence a diagnostic. See
[responding to findings](query-checking.md#responding-to-findings).

Share runtime connection/codecs through `tenon.config.ts`; CLI generation, checking, inspection,
and migrations read it. Use `--config` for another role/deployment. Match runtime role, search path,
timezone, and codecs. Describe uses a separate session and
cannot establish result nullability, JSON members, cardinality, or execution permissions. Native
calls bypass Tenon's guards/observations and need explicit resource ownership; see
[connections and driver access](connections.md). For common failures, use
[troubleshooting](reference.md#troubleshooting).
