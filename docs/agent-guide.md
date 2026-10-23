# Tenon agent guide

Tenon executes PostgreSQL SQL through application-owned `pg` configuration. It
provides parameter binding, transactions, optional guarded writes, SQL migrations,
and generated table row types. Use the [human guide](human-guide.md) for setup and
explanations; use [adoption](adoption-guide.md) when replacing another ORM.

## Working conventions

1. Read existing connection setup, migrations, generated definitions, query modules,
   and check commands. Reuse the pool, namespace conventions, and environment setup.
2. Prefer ordinary functions for application queries. Use `defineOperation` when a
   reusable query factory needs shared return/affected-row options. Avoid wrapping
   every query in a new abstraction.
3. Select explicit columns. Keep result projections stable; use separate complete
   queries when variants return different shapes.
4. Run the application's SQL checker after changing SQL. Generate/repair annotations
   explicitly, inspect the diff, then typecheck and run relevant database tests.
5. Keep application validation, authorization, parser configuration, retries, and
   business policy in the application. Do not infer authorization from quoted names.

## Install and connection

```sh
npm install @kequtech/tenon-orm pg
npm install --save-dev typescript@^6 @types/node@^24 @types/pg
```

Node.js 24+, PostgreSQL 16+, ESM, TypeScript 6+. Use strict TypeScript with NodeNext.

```ts
import { createTenon } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
export const db = createTenon({ connection });
```

`connection`: URL, `pg.PoolConfig`, or existing `pg.Pool`. Explicit `{}` selects pg's
environment defaults. Reuse one database instance. `close()` closes owned pools;
borrowed pools remain application-owned. Install the application's error handler
on borrowed pools. Qualify names or configure `search_path`; tooling `--namespace`
does not change runtime queries. Environment files are not loaded automatically.

## Query contracts

```ts
import { sql } from '@kequtech/tenon-orm';
import type { User } from './generated-schema.js';

type Summary = Pick<User, 'id' | 'email'>;
const user = await db.query(sql<Summary>`SELECT id, email FROM public."User" WHERE id = ${id}`, {
  returns: 'oneOrNone',
});
```

`sql<Row>` describes one selected row. It does not prove SQL/type agreement or
validate JSON. Unannotated fields remain `unknown`. Generated types describe full
table rows; joins, expressions, aliases, and aggregates need actual projection types.

| `returns`          | Result                | Row-count contract |
| ------------------ | --------------------- | ------------------ |
| `native` (default) | pg `QueryResult<Row>` | Any                |
| `many`             | `Row[]`               | Any                |
| `oneOrNone`        | `Row \| undefined`    | At most one        |
| `one`              | `Row`                 | Exactly one        |

Return modes never insert `LIMIT` or `RETURNING`. Returned-row checks alone do not
undo autocommitted writes. `query` options are `{ returns?, affectedRows?, label? }`.

`defineOperation(factory, options)` takes a synchronous factory returning a query.
Run with `db.run(operation, [input])` or `tx.run`; parameterless factories take `[]`.
Options belong to the definition, not the call site.

## SQL and composition

- Interpolated values bind `$1`, `$2`, etc. Never quote interpolations or author
  manual `$n` placeholders inside templates. `undefined` binds SQL null. Cast
  standalone parameter projections to their intended PostgreSQL types.
- `identifier(schema, table)` quotes separate application-approved components.
- `sql.fragment` creates an immutable piece of SQL without a result type.
- `sql.join(fragments, separator)` accepts only fragments and an explicit fragment
  separator. Empty lists and blank fragments throw; choose empty-filter semantics
  explicitly. Preserve tenant/authorization predicates when adding optional filters.
- Parenthesize logical groups. Use application-selected fragments containing `ASC`
  or `DESC` for ordering; interpolated ordinary strings remain values.
- Full `sql` and `unsafeSql` queries cannot be nested. Fragments cannot execute alone.
- `unsafeSql<Row>(text, values)` is for externally authored, trusted SQL with an
  explicit values array. Never concatenate request input into its text.

```ts
const tenant = sql.fragment`tenant_id = ${tenantId}`;
const active = sql.fragment`active = ${true}`;
const query = sql<Summary>`SELECT id, email FROM public."User"
  WHERE ${sql.join([tenant, active], sql.fragment` AND `)} ORDER BY id`;
```

Use existing schema columns; this example assumes `tenant_id`. Prefer static SQL
with nullable parameters for simple optional filters. Runtime-built fragment lists
are supported for execution but need explicit checker exclusions and database tests.
Each call still executes one statement.

## Result typing workflow

Use `tenonSafeql` from `@kequtech/tenon-orm/safeql` with the application's ESLint
configuration and an explicit development/test database URL. Setup and scripts are
in [result typing with SafeQL](human-guide.md#result-typing-with-safeql). The preset
uses TypeScript 6 tooling; it is not part of runtime imports.

1. Apply migrations to the intended development/test schema.
2. Regenerate table definitions if the schema changed.
3. Run the application's `sql:check` (ESLint without `--fix`).
4. For missing/stale annotations, inspect the query and use `sql:fix` deliberately.
   Fix SQL mistakes before accepting types generated from unintended queries.
5. Run typechecking and database tests. CI must check without fixing files.

The checker resolves Tenon import aliases, constant fragments, nested fragments,
literal join lists, and literal/const identifier strings. It rejects mutable,
conditional, function-generated, or runtime-built composition with a diagnostic.
It does not evaluate application code. Prefer supported forms; when runtime SQL
is necessary, retain explicit result types, narrowly suppress the reported rule
with a reason, and test the branches. Never hide an unsupported query with `any`.

Fragments support primitive and primitive-array parameters in the checker. Put
complex values in the outer template. `unsafeSql` is unchecked. JSON remains
`unknown`; custom pg parsers, recursive arrays, and unsupported database types need
matching overrides and tests. Bigint/numeric scalars are strings; numeric arrays
are numbers and may lose precision. Temporal values include infinities represented
as numbers. See the human guide for mappings and column overrides.

## Transactions and writes

Use `db.transaction(async (tx) => ...)`; use `tx` for every query in its scope and
await all work. The callback commits on success and rolls back on an escaping error.
Do not issue direct BEGIN/COMMIT/ROLLBACK boundaries or use the client after return.
`QueryClient` is the common helper parameter type for `db` and `tx`.

Use `affectedRows: { exact: n }` or `{ max: n }` for INSERT/UPDATE/DELETE/MERGE when
the write must respect a count. Counts are nonnegative safe integers. Checks use a
root transaction or a transaction-local savepoint and undo a rejected write. A
caught guarded failure allows continued work; ordinary SQL failures may abort the
transaction. Reserve savepoint names starting with `tenon_affected_rows_`.

Affected counts cover the final command, not trigger/cascade/CTE side effects.
They cannot identify the wrong single row. Sequence advances and external effects
are not reversible. A lost commit acknowledgment may leave the outcome unknown;
retry only according to application policy. Native pg errors retain their details;
`AffectedRowsError` has stable Tenon codes; cleanup failures may use `AggregateError`.

`onQuery` observes labels, duration, outcome, and available command/count/error code;
no SQL or values are supplied. Observers are not awaited. Callback success does not
mean the outer transaction committed.

## Schema changes and CLI

```sh
npx tenon new create_users
npx tenon migrate
npx tenon generate --out src/generated-schema.ts
npx tenon generate --out src/generated-schema.ts --check
npx tenon status
npx tenon rollback --steps 1
```

Database commands require `DATABASE_URL`. Migration commands accept `--directory`
and `--namespace`; generation accepts `--namespace`. Fill scaffolded up/down SQL;
remove a down file for an intentionally irreversible migration. Never edit applied
files. Commit migrations and generated definitions together.

Each migration commits separately with its history entry. Later failure leaves
earlier commits applied. Tools use session advisory locks; use a direct connection
or session pooling and application timeouts. Nontransactional DDL needs a separate
procedure. `generate --check` detects representation drift, not pending migrations
or every possible schema change. Generation covers ordinary tables and partitioned
roots; views/foreign tables need authored query types.

For existing databases, follow the adoption guide: capture one reviewed baseline,
adopt only at its matching checkpoint, and migrate fresh databases normally.
A down migration or schema-only baseline is not a data backup.
