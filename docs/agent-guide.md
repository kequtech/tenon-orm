# Tenon agent guide

Tenon executes PostgreSQL SQL through `pg`, with parameter binding, transactions, optional write
limits, SQL migrations, and generated table row types. Use ordinary functions for reusable queries.
This guide contains the setup and contracts needed for routine implementation; the
[reference](reference.md) covers additional options.

## Working conventions

1. Inspect the application's connection setup, migrations, generated types, query modules, and check
   commands. Reuse them. Do not replace a working migration runner just to use Tenon queries.
2. Write straightforward SQL with explicit selected columns. Use separate complete queries when
   variants return different shapes. Introduce fragments only for actual reuse or variable
   composition.
3. Put reusable queries in functions. Accept a `QueryClient` and named object inputs when useful;
   keep SQL and query options together. Call the same function with `db` or `tx`.
4. After SQL changes, run the configured checker, typechecking, and relevant database tests.
   Generate/repair annotations deliberately and inspect the diff.
5. Keep validation, authorization, retries, and parser configuration in the application. A quoted
   identifier or correct row count does not prove authorization.

## Install and connect

Requires Node.js 24+, PostgreSQL 16+, ESM, TypeScript 6+, and Node development typings. Keep the
application's strict TypeScript configuration.

```sh
npm install @kequtech/tenon-orm pg
npm install --save-dev @types/pg
```

```ts
import { createTenon } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
export const db = createTenon({ connection });
```

`connection` accepts a URL, `pg.PoolConfig`, or existing `pg.Pool`. An explicit `{}` selects pg's
environment defaults. Reuse one instance per database connection. `close()` closes owned pools;
supplied pools remain application-owned and need the application's idle-error handler. Await
outstanding work before closing. Environment files are not loaded automatically. Qualify SQL names
or configure `search_path`; CLI `--namespace` does not change runtime query names.

## Query contracts

```ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';
import type { User } from './generated-schema.js';

type Summary = Pick<User, 'id' | 'email'>;

function userById(client: QueryClient, { id }: { id: number }) {
  return client.query(sql<Summary>`SELECT id, email FROM public."User" WHERE id = ${id}`, {
    returns: 'oneOrNone',
  });
}

const user = await userById(db, { id: 42 });
// In a transaction, call userById(tx, { id: 42 }).
```

`sql<Row>` describes one selected row. It does not prove SQL/type agreement or validate JSON.
Unannotated fields stay `unknown`. Generated types describe full table rows; joins, aliases,
aggregates, and expressions need projection-specific types.

| `returns`          | Result                | Row-count contract |
| ------------------ | --------------------- | ------------------ |
| `native` (default) | pg `QueryResult<Row>` | Any                |
| `many`             | `Row[]`               | Any                |
| `oneOrNone`        | `Row \| undefined`    | At most one        |
| `one`              | `Row`                 | Exactly one        |

`query` options are `{ returns?, affectedRows?, label? }`; unknown options fail. Return modes never
insert `LIMIT` or `RETURNING`. Returned-row checks alone do not undo autocommitted writes. `label`
is an optional nonempty diagnostic string.

## Parameters and composition

- Ordinary interpolations bind values. Do not quote them or author manual `$n` placeholders inside
  templates. `undefined` binds SQL null.
- PostgreSQL infers parameter types from SQL. Cast standalone projections, e.g.
  `SELECT ${value}::float8 AS value`; without a cast, a standalone parameter returns text.
- Use `id = ANY(${ids}::integer[])` for an array of IDs. Do not build a comma-separated string of
  values.
- `identifier(schema, table)` quotes separate application-approved components. Ordinary strings such
  as `'DESC'` remain bound values, not SQL syntax.
- `sql.fragment` carries SQL and bound values without a row type. Use it for shared predicates or
  partial SQL. Fragments cannot execute alone; full `sql` and `unsafeSql` queries cannot be nested.
- `sql.join(fragments, separator)` requires a nonempty array of fragments and exactly `'AND'`,
  `'OR'`, or `','`. No fragment or arbitrary-string separator is accepted. Empty lists and blank
  fragments throw. Choose empty-filter behavior explicitly.
- Joins add no parentheses. Group mixed `AND`/`OR` predicates explicitly and preserve authorization
  conditions when adding optional filters.
- `unsafeSql<Row>(text, values)` accepts trusted external SQL with an explicit values array. Never
  concatenate request input into its text. Each query executes one statement.

For example, share a search condition between a page and count query:

```ts
const search = sql.fragment`active = ${true} AND email ILIKE ${pattern}`;
const page = sql<Summary>`SELECT id, email FROM public."User"
  WHERE ${search} ORDER BY id LIMIT ${limit}`;
const count = sql<{ count: string }>`SELECT count(*) AS count FROM public."User"
  WHERE ${search}`;
```

`pattern` and `limit` are validated application inputs. To compose existing predicates, use
`sql.join([first, second], 'AND')`. The checker supports literal join arrays, constant fragments,
and literal/const-string separators. It rejects mutable, conditional, function-generated, or
runtime-built composition. Prefer fixed SQL for simple optional filters, e.g.
`(${email}::text IS NULL OR email = ${email})`. If runtime composition is required, retain an
explicit result type, suppress `tenon/check-composition` only on that query with a reason, and test
each branch. Parameter binding alone does not establish result correctness.

## Configure and run SQL checking

SafeQL checks SQL against the development/test schema and generates or verifies result annotations.
Configure it normally and add both exports from `@kequtech/tenon-orm/safeql`:

- `safeqlPlugin` goes in each SafeQL connection's `plugins`. It translates Tenon SQL and constant
  fragments and supplies pg type mappings. SafeQL performs result inference.
- `eslintPlugin` goes in ESLint's `plugins`, with `tenon/check-composition` enabled. It reports
  unsupported forms that the adapter skips. It does not wrap SafeQL's rule.

These tools are optional development tooling; the database runtime does not import them. SafeQL,
ESLint, and TypeScript are optional peers. The application owns the TypeScript parser configuration
and imports SafeQL and typescript-eslint itself. Use a TypeScript version supported by the lint
toolchain. Generated table types are optional and not required by SafeQL.

Reuse existing configuration and scripts. For a new setup:

```sh
npm install --save-dev eslint typescript-eslint @ts-safeql/eslint-plugin
```

```js
// eslint.config.mjs
import { defineConfig } from 'eslint/config';
import safeql from '@ts-safeql/eslint-plugin/config';
import tseslint from 'typescript-eslint';
import { safeqlPlugin, eslintPlugin } from '@kequtech/tenon-orm/safeql';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for SQL checking');

export default defineConfig({
  files: ['src/**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true },
  },
  plugins: { tenon: eslintPlugin },
  rules: { 'tenon/check-composition': 'error' },
  extends: [
    safeql.configs.connections({
      databaseUrl,
      plugins: [safeqlPlugin],
      targets: [{ tag: 'sql' }],
    }),
  ],
});
```

Point the URL at the intended development/test database with migrations applied. Supply environment
variables through the application; no `.env` file is loaded here. `projectService` uses each file's
nearest TypeScript project. Preserve existing type-aware parser settings if already configured.

`targets` matches the tag spelling. Add aliases to the target list when using them. For a single
database, `{ tag: { regex: '.*' } }` includes all Tenon aliases and typed object properties; the
adapter excludes unrelated tags. The composition rule checks every Tenon query in its ESLint file
scope, independently of SafeQL's targets.

Reuse existing lint scripts or add:

```json
{
  "scripts": {
    "lint": "eslint \"src/**/*.ts\"",
    "lint:fix": "eslint \"src/**/*.ts\" --fix"
  }
}
```

SQL and annotation errors come from `@ts-safeql/check-sql`; unsupported composition errors come from
`tenon/check-composition`. Keep both rules enabled.

1. Run the development `db:migrate` script below against the intended development/test database.
2. Run `npm run lint`. Fix SQL mistakes before accepting generated types.
3. Run `npm run lint:fix` for missing/stale annotations. It can add
   `sql<{ id: number; email: string }>` to a query selecting those columns. Review the diff; other
   enabled ESLint rules may also fix files.
4. Run the application's typecheck and database tests. CI runs `lint` without `--fix`.

For multiple databases, replace the connection object with an array. Each connection has its own
URL, `plugins: [safeqlPlugin]`, and distinct `targets`, for example `{ tag: 'usersSql' }` and
`{ tag: 'billingSql' }`. Import `sql as usersSql` and `sql as billingSql` to select them, even
within one file. Alternatively, scope separate SafeQL configurations with non-overlapping ESLint
`files` patterns and keep the `sql` tag. Runtime connections remain independent: execute each query
with the right database instance. The checker does not trace `db.query` destinations.

Qualify tables with their schema when names repeat across schemas in a database. SafeQL can infer
the wrong type for an unqualified table despite the connection's `search_path`; explicit schema
names avoid that ambiguity.

The checker recognizes Tenon imports, aliases, and typed object properties. It resolves constant
fragments and literal/const identifier names without executing application code. Imported fragments
need inspectable source initializers. Use literal newlines and bound string values: outer-template
JavaScript escapes are rejected because SafeQL reads raw text while Tenon executes decoded text.
Bound values and constant fragments are decoded consistently.

Checking verifies SQL and result annotations, not JavaScript input compatibility, authorization, or
JSON contents. PostgreSQL owns parameter inference; the checker adds no casts based on JavaScript
types. `unsafeSql` is unchecked. Never use `any` to hide an unsupported query.

Default scalar mappings: bigint/numeric are strings; JSON is `unknown`; temporal values are
`Date | number` because infinities are numbers. Generated `PgArray<T>` supports recursive dimensions
and null elements. Numeric arrays contain numbers and can lose precision. Custom pg parsers and
recursive array projections need matching checker overrides and tests, for example
`overrides: { columns: { 'User.tags': 'PgArray<string>' } }` on the SafeQL connection. Import
`PgArray` from the generated definitions when using that annotation.

## Transactions and writes

Use `db.transaction(async (tx) => ...)`; use `tx` for every query in scope and await all work. The
callback commits on success and rolls back on an escaping error. Do not issue direct
BEGIN/COMMIT/ROLLBACK boundaries or use `tx` after return. Transactions do not span database
instances. Nested callback transactions and automatic retries are not provided.

Use `affectedRows: { exact: n }` or `{ max: n }` for INSERT/UPDATE/DELETE/MERGE when a write must
respect a count. Bounds are nonnegative safe integers. A guarded `db.query` uses a transaction; a
guarded `tx.query` uses a savepoint. Rejected writes are rolled back before throwing. A caught
guarded failure permits continued work; ordinary SQL failures may abort the transaction. Reserve
savepoint names beginning with `tenon_affected_rows_`.

Affected counts cover the final command, not extra trigger/cascade/CTE effects. They cannot detect
the wrong single row. Sequence advances and external effects are not reversible. A lost commit
acknowledgment may leave the outcome unknown; retry only according to application policy. Native pg
errors retain their details; `AffectedRowsError` has codes `TENON_AFFECTED_ROWS_MISMATCH` and
`TENON_AFFECTED_ROWS_UNSUPPORTED`. Cleanup failures can produce `AggregateError`.

Optional `onQuery` observes labels, duration, outcome, and available command/count/ error code,
without SQL or values. Observers are not awaited. Query success inside a callback does not mean the
outer transaction committed.

## Schema changes

Reuse the application's migration setup. With Tenon's runner and generated table types, use this
development script in `package.json`:

```json
{
  "scripts": {
    "db:migrate": "tenon migrate && tenon generate --out src/generated-schema.ts"
  }
}
```

```sh
npx tenon new create_users
# Fill the generated up/down SQL before migrating.
npm run db:migrate
npx tenon generate --out src/generated-schema.ts --check
npx tenon status
npx tenon rollback --steps 1
```

Commit migrations and generated types together. Production runs only `npx tenon migrate` and deploys
the already-built application. Omit generation from the development script if table types are
unused.

Database commands require `DATABASE_URL`. Migration commands accept `--directory` (default
`migrations`) and `--namespace` (default `public`); generation accepts `--namespace`. Files use
`<numeric-id>_<name>.up.sql` with optional matching down SQL. Omit a down file for an intentionally
irreversible migration. Never edit applied files. For a custom namespace, pass it to both commands
in the development script.

Each migration commits with its history entry; earlier files remain applied if a later one fails.
Tools use session advisory locks: use a direct connection or session pooling and application
timeouts. Nontransactional DDL needs a separate procedure. `generate --check` detects representation
drift, not pending migrations or every possible schema change. Generation covers ordinary tables and
partitioned roots; views/foreign tables need authored query types.

When replacing another ORM, preserve its schema and behavior. If transferring migration ownership,
capture one reviewed baseline with `tenon baseline capture`, record it only on matching existing
databases with `tenon baseline adopt`, and use `tenon migrate` on fresh databases. Adoption does not
compare schemas or run baseline SQL. See [adoption](adoption-guide.md) for the full transition
procedure. A down migration or schema-only baseline is not a data backup.
