# Tenon

Hello, agent. Your human would like you to change a database. Please leave evidence.

Tenon is an experimental PostgreSQL toolkit for TypeScript and JavaScript. It
combines explicit SQL migrations, generated row types with schema comments, inline
SQL and named SQL operations. You write the SQL; PostgreSQL executes it; Tenon
keeps the contracts close enough to inspect. Humans are welcome to read them too.

**Status:** pre-release, not ready for production adoption. The package name is
`@kequtech/tenon-orm`; npm publication is pending. Node.js **24+**, PostgreSQL
**16+**, ESM only. TypeScript consumers need **5.7.2+** with the tested typings.
[ISC licensed](LICENSE), maintained by [Kequtech](https://github.com/kequtech).

## Read this before editing

1. Read the application's SQL migrations and committed generated schema file.
   Its comments describe keys, constraints, indexes, defaults and domains.
2. Author a new SQL migration for schema changes. Applied files are immutable.
3. Migrate a development database, regenerate types and commit both artifacts.
4. Put SQL inline or register a named operation. Declare the actual returned row
   and, for named operations, the input tuple in `$1`, `$2`, … order.
5. Use callback transactions for work that must commit together. Await every query.
6. Run the application's typechecks and behavioral tests. A plausible type is
   not evidence that the SQL returns it. Confident narration is also not evidence.

SQL owns joins, filters, ordering, pagination, aggregates, conflict handling,
bulk writes and `RETURNING`. Application code owns validation, result transforms,
IDs and timestamps that are not database defaults. There is no runtime model
registration, relation DSL, automatic query batching or schema synchronization.

## Install and create a schema

After an npm release is available:

```sh
npm install @kequtech/tenon-orm pg
npm install --save-dev @types/pg
```

The application owns `pg` (required peer: `^8.23.1`). TypeScript consumers supply
`@types/pg` during development because Tenon's public declarations use native pg
types. JavaScript and compiled production code need neither typings nor a
compiler. Tenon has no regular dependencies; TypeScript is an optional peer.
Independent typings upgrades may raise the consumer compiler requirement.

The installed `tenon` executable provides migrations and generation. The examples
below use `npx tenon`; package scripts can invoke `tenon` directly. For an
unpublished checkout, see [development instructions](https://github.com/kequtech/tenon-orm/blob/main/docs/contributing.md).

```sh
npx tenon new create_users
```

This creates two empty files without a database. Fill them before migrating:

```sql
-- migrations/0001_create_users.up.sql
CREATE TABLE "User" (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);
```

```sql
-- migrations/0001_create_users.down.sql
DROP TABLE "User";
```

Set `DATABASE_URL` to the intended database using your application's environment
configuration. Tenon reads the process environment; it does not load `.env` files.

```sh
npx tenon migrate
npx tenon generate --out src/generated-schema.ts
npx tenon generate --out src/generated-schema.ts --check
```

Generation creates ordinary types, including `User` and `Rows['User']`, plus
schema comments and applied migration IDs/checksums. Commit this file. Production
executes migrations and runs the prebuilt application; generation is a separate
development/verification step and never runs automatically during migration.

## Connect and execute SQL

```ts
import { createTenon, define } from '@kequtech/tenon-orm';
import type { User } from './generated-schema.js';

type UserSummary = Pick<User, 'id' | 'email'>;

const user_by_email = define<UserSummary, [email: User['email']]>(
  'SELECT id, email FROM public."User" WHERE email = $1',
  { returns: 'one' },
);

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');

const db = createTenon({ connection, operations: { user_by_email } });
try {
  const users = await db.sql<UserSummary>(
    'SELECT id, email FROM public."User" WHERE active = $1 ORDER BY id',
    [true],
  );
  console.log(users.rows, users.rowCount); // Native pg.QueryResult<UserSummary>.

  const user = await db.run('user_by_email', ['agent@example.test']);
  console.log(user?.email); // UserSummary | undefined.
} finally {
  await db.close();
}
```

`createTenon`, `tenon` and the default export are the same constructor. Its options
are `{ connection, operations? }`. Connection accepts a connection string, native
`pg.PoolConfig` or existing `pg.Pool`. Tenon closes pools it creates; a supplied
pool remains owned by the caller. `close()` is idempotent and rejects subsequent
work through that Tenon instance.

Runtime clients have no namespace setting. Qualify names in SQL or configure
PostgreSQL's `search_path` on the connection. Tooling's `--namespace` is separate.
Connection settings, TLS and pool tuning remain native pg configuration.

Every `sql` and `run` call requires an input array, including `[]`. Bind values
with `$1`, `$2`, …; identifiers belong in authored SQL, not value parameters.
Each call executes one statement, including parameterless calls. SQL text and
driver values pass through without case conversion or value normalization.

## Result contracts

`sql<Row>(text, inputs, options?)` describes **one SQL record**. Use `User`,
not `User[]`, as the row generic. `define<Row, Inputs>(text, options?)` has the
same result modes:

| `returns` | Result | Zero returned rows | More than one |
| --- | --- | --- | --- |
| `native` (default) | `QueryResult<Row>` | Native result with `rows: []` | Return all |
| `many` | `Row[]` | `[]` | Return all |
| `one` | `Row \| undefined` | `undefined` | Throw `TenonError` |
| `requiredOne` | `Row` | Throw `TenonError` | Throw `TenonError` |

```ts
const inserted = await db.sql<UserSummary>(
  'INSERT INTO public."User" (email) VALUES ($1) RETURNING id, email',
  ['new@example.test'],
  { returns: 'requiredOne' },
);

const users = await db.sql<UserSummary>(
  'SELECT id, email FROM public."User" ORDER BY id',
  [],
  { returns: 'many' },
);

const changed = await db.sql(
  'UPDATE public."User" SET active = $1 WHERE id = $2',
  [false, inserted.id],
);
console.log(changed.command, changed.rowCount);
```

Native mode returns the original pg result, including `rows`, `rowCount`,
`command`, `fields` and `oid`. `rowCount: null` means PostgreSQL supplied no count;
zero means it supplied zero. Aggregate values are fields in returned rows.
`QueryResult` is also re-exported as a type.

Row modes inspect `result.rows`, including for writes without `RETURNING`. They
check cardinality **after SQL executes**; they never add `LIMIT` or restrict the
rows affected by a write. An autocommitted write stays committed if a later
cardinality check fails. Let the error escape a transaction callback when such
a mismatch should roll back the write.

The row generic defaults to `never`, useful for commands whose returned fields
you do not access. It does not discard runtime rows or verify that none exist.
Without a declared row type, `many` is `never[]`, `one` is `undefined` and
`requiredOne` is `never`. Tenon does not infer types from SQL or validate fields
at runtime. Declare aliases, outer-join nullability, expressions, JSON and other
query-specific output accurately.

### Named operations

Definitions are immutable SQL/result contracts. Compose registries with ordinary
imports and objects; names are object keys, with no directory convention:

```ts
const disable_user = define<never, [id: User['id']]>(
  'UPDATE public."User" SET active = false WHERE id = $1',
);
const db = createTenon({ connection, operations: { user_by_email, disable_user } });

await db.run('disable_user', [42]);
const user = await db.run('user_by_email', ['agent@example.test']);
```

`run` infers the input tuple and result from the named definition. Its result mode
is fixed; there is no third argument or call-site override. Omitted `Inputs`
defaults to `[]`, not an unchecked list. Inline SQL inputs accept readonly arrays
without SQL-derived static parameter checking. PostgreSQL checks actual binding.

## Transactions, isolation and partial recovery

```ts
const user = await db.transaction(async tx => {
  await tx.sql('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', []);
  await tx.sql("SET LOCAL statement_timeout = '5s'", []);

  const inserted = await tx.sql<UserSummary>(
    'INSERT INTO public."User" (email) VALUES ($1) RETURNING id, email',
    ['transaction@example.test'],
    { returns: 'requiredOne' },
  );
  const found = await tx.run('user_by_email', [inserted.email]);
  if (!found) throw new Error('Expected inserted user');
  return found;
});
```

One checked-out connection serves `tx.sql` and `tx.run`. A successful callback
commits; an escaping error rolls back. Its value reaches the caller after commit.
Root `db` calls remain independent. Await all transaction work before returning;
transaction clients reject new work once the callback finishes, including during
commit or rollback. An aborted PostgreSQL transaction cannot report a successful
commit just because the callback caught the original error.

Isolation defaults to the connection's setting. Set it with SQL before the first
data query. Applications own retry policy and idempotency. PostgreSQL's
`statement_timeout` can be configured on the connection or with `SET LOCAL`;
there is no Tenon timeout or caller-cancellation option.

For partial recovery, use explicit `SAVEPOINT name`, `ROLLBACK TO SAVEPOINT name`
and `RELEASE SAVEPOINT name` through `tx.sql` or named definitions. Await each
step. Tenon owns the outer boundary and rejects direct `BEGIN`, `START
TRANSACTION`, `COMMIT`, `END`, full `ROLLBACK`/`ABORT` and prepared-transaction
commands through public execution. The guard checks leading commands, not SQL
bodies; it is not a SQL analyzer or security boundary.

Results are buffered. For chunked reads, author pagination or use
`DECLARE ... CURSOR FOR ...`, `FETCH` and `CLOSE` inside the callback. Process
batches before it ends. Nested callback helpers, automatic savepoints, automatic
retries, streaming iterators and manual transaction handles are not implemented.

## Migrations and CLI

```text
tenon new <name> [--directory migrations]
tenon migrate [--directory migrations] [--namespace public]
tenon status [--directory migrations] [--namespace public]
tenon rollback [--directory migrations] [--namespace public] [--steps 1]
tenon generate [--directory migrations] [--namespace public]
               [--out src/generated-schema.ts] [--check]
tenon baseline capture [--directory migrations] [--namespace public]
                       [--schema name ...]
tenon baseline adopt [--directory migrations] [--namespace public]
tenon --help
```

`new` and `--help` need no database. All other commands require `DATABASE_URL`.
Errors go to stderr with a nonzero exit status. `status` prints JSON arrays of
applied and pending migration IDs. CLI warnings go to stderr, including during
freshness checks. Commands do not create databases, users or credentials.

Migration names are numeric IDs plus a description:
`0001_create_users.up.sql` and optional `0001_create_users.down.sql`. IDs sort
numerically; names use letters, digits, underscores and hyphens. `new` chooses
the next number, with at least four digits, creates empty files and never
overwrites existing ones. A local directory lock serializes creation. After a
crash, remove a stale `.tenon-create.lock` only after the creator has stopped.
Empty SQL files fail validation; remove the down file for irreversible changes.

`migrate` creates the selected namespace if needed and applies pending up files.
Each file may contain multiple SQL statements; its SQL and history update commit
in one transaction. Do not include transaction-control statements in migration
files. Operations prohibited inside a transaction, such as `CREATE INDEX
CONCURRENTLY`, are outside this runner's supported subset.

`__tenon_migrations` stores IDs, names, exact-content checksums and application
times in the selected namespace. Checksums cover both up and down SQL. Restore
changed/missing applied files; make later changes in a new migration. A failed
file rolls back, while earlier files in that run stay committed. `rollback`
prechecks that every selected file has down SQL, then executes them in reverse
order. Down SQL does not recover discarded data.

Exclusive PostgreSQL advisory locks coordinate migrate/rollback/adoption; shared
locks coordinate generation/status in the same database and namespace. Conflicts
wait using PostgreSQL's configured `lock_timeout`; its default can wait
indefinitely. History is read after locking. There is no Tenon polling or retry
loop. These locks do not coordinate other migration tools or application traffic.

For deployment, run reviewed migrations against the intended database, then run
compatible application code. Use backward-compatible schema changes when old and
new application versions overlap. Backups, long-running backfills, recovery and
nontransactional maintenance remain application/operator responsibilities.

## Generated types and schema evidence

`generate` introspects the **current** database schema in one read-only,
repeatable-read snapshot. It does not apply migrations. Pending files warn but do
not prevent generation, including after rollback. Changed or missing applied
files fail history validation.

`--check` compares the full output to an existing file and fails when it is stale
or missing, without rewriting it. Comments, types and `migrationHistory` all
participate. To verify the latest intended schema, replay migrations into a fresh
namespace before checking. History alone cannot detect out-of-band changes.

Full row types include every column as a required property. SQL column `NOT NULL`
controls nullability, not defaults or insert-time optionality. Use `Pick`, indexed
access, intersections and ordinary object types for each query. `Rows` preserves
exact SQL table names; legal, non-conflicting names also receive named aliases.
Use `Rows['user-details']` or `Rows['Rows']` when a name cannot be a row alias.
The file has no runtime imports or schema registration.

Schema comments describe column types/nullability; primary, unique, foreign-key,
check and exclusion constraints; complete index definitions and validity;
defaults, identity declarations and generated expressions. Referenced domains
include bases, modifiers, collations, defaults and constraints. PostgreSQL
provides the definitions. Names and ordering are stable; every catalog-text line
is safely commented. Sequence positions do not change the artifact.

This is schema context for SQL authors, not an executable dump. Triggers,
row-security policies, permissions and other objects still require migrations
or direct PostgreSQL inspection.

### Driver mappings

Tenon preserves standard pg values and installs no parser overrides:

| PostgreSQL scalar | Generated TypeScript |
| --- | --- |
| `integer` (`int4`) | `number` |
| `bigint`, `numeric` / `decimal` | `string` |
| `boolean` | `boolean` |
| `text`, `varchar`, `uuid` | `string` |
| `timestamptz` | `globalThis.Date` |
| Native enum | Literal string union |
| `json`, `jsonb` | `unknown` |
| `bytea` | `import('node:buffer').Buffer` |

Nullable verified scalar columns add `null`. `unknown` already includes null;
JSON intentionally emits no warning. Declare JSON contracts beside queries and
validate application input where needed. A TypeScript shape does not validate
stored JSON. Date precision follows the driver/JavaScript representation.

Verified arrays use a generated, type-only recursive helper:

```ts
export type PgArray<T> = (T | null | PgArray<T>)[];
```

| Verified array | Leaf type |
| --- | --- |
| `integer[]`, `numeric[]` | `number` |
| `bigint[]`, `text[]`, `varchar[]`, `uuid[]` | `string` |
| `boolean[]` | `boolean` |
| `timestamptz[]` | `globalThis.Date` |
| `bytea[]` | `Buffer` |
| `json[]`, `jsonb[]` | `unknown` |

Array column nullability is separate. Dimensions are not fixed by SQL array
declarations. Null elements, nested arrays and native driver behavior remain
intact; pg discards nonstandard lower bounds. The numeric-array parser uses
numbers and can round values even though scalar numeric uses strings. Cast to
`text[]` in SQL when exact numeric array values are required.

Nested domains use a verified underlying scalar, enum or array mapping.
PostgreSQL enforces domain constraints; Tenon adds no brands or validation.
Domain `NOT NULL` alone does not narrow a column: already-domain-typed nulls can
still appear in PostgreSQL expressions. The column's own flag controls its type.

Unverified types, including composites, enum arrays, arrays of domains and domains
over unsupported bases, generate `unknown` with one warning per column. Warnings
identify the declared type/OID and column, including an unmapped domain base.
Other fields retain their mappings. Warnings do not fail generation or `--check`.
Custom parsers require corresponding application-owned query contracts.

Ordinary tables and top-level partitioned tables are generated. Attached
partitions, including intermediate/default partitions, are omitted. Direct
partition queries can reuse the root type or declare their own output. Partition
maintenance alone leaves the artifact unchanged when migration history is
unchanged; detached tables become independent models. New migrations still
change the recorded history even when row types are equal.

Views, materialized views and foreign tables use manual query types. They are
skipped before column inspection, do not block table generation and do not add
warnings or otherwise-unused domains. No foreign data source is contacted.

## Adopt an existing database

1. Choose one final schema checkpoint for the old ORM. Bring each existing target
   database to it before adoption. Freeze its migrations/schema synchronization;
   Tenon's locks do not coordinate the old tool.
2. Capture one shared baseline from the reference database into an empty Tenon
   migration directory:

   ```sh
   npx tenon baseline capture --directory migrations --namespace public
   ```

   This writes `0001_baseline.up.sql` with no down file, using native `pg_dump
   --schema-only --no-owner --no-privileges`. Default scope is the complete
   database schema. Repeat `--schema name` for native schema selection; own its
   dependencies and required extensions/roles. Capture excludes Tenon's history,
   preserves existing files, and changes no source history, data or sequence
   positions. Existing ORM metadata is left in the captured schema.
3. Review and commit that SQL. On each existing database at the checkpoint:

   ```sh
   npx tenon baseline adopt
   npx tenon generate --out src/generated-schema.ts
   ```

   Adoption records the baseline checksum without executing its SQL. It requires
   an existing namespace and the first `0001_baseline.up.sql` with no down file.
   Repeating matching adoption is a no-op, even after later Tenon migrations;
   conflicting history fails. Tenon does not compare the actual target schema.
4. Replace the old ORM's application behavior and deployment commands. Own its
   validation, IDs, timestamps, hooks, serialization, seeds, metadata cleanup and
   backups. Prefer a schema-preserving replacement release so application rollback
   can redeploy compatible code. Databases may transition at different times;
   instances sharing one database share its adoption.
5. Existing databases adopt once, then use ordinary `migrate` for later files.
   **Fresh databases run `migrate` directly** to execute the saved baseline and
   subsequent migrations. Do not run adoption unconditionally on fresh databases.
   Use one shared baseline, not a different capture for every environment.

Capture needs `pg_dump` on PATH with native client/server compatibility; prefer
the server's major. Other commands use pg and need no PostgreSQL client binary.
Tenon's adapter removes outer psql restrict directives and makes dump preamble
settings transaction-local. Captured object bodies remain PostgreSQL's concern.
Keep the capture header; normal transactional execution and checksums still apply.
The omitted down file stops normal rollback through the baseline; it is not a
backup or a restore plan.

## Programmatic tools and errors

All tools are named exports from `@kequtech/tenon-orm`:

| Function | Arguments | Resolves to |
| --- | --- | --- |
| `createMigration` | `{ name, directory? }` | `{ id, upPath, downPath }` |
| `readMigrations` | `directory?` | Ordered `SqlMigration[]` (readonly) |
| `migrate` | Database tool options | Applied IDs (readonly array) |
| `rollback` | Database tool options plus `steps?` | Rolled-back IDs (readonly array) |
| `migrationStatus` | Database tool options | `{ applied, pending }` IDs |
| `generateDefinitions` | Database tool options plus `onWarning?` | TypeScript source string |
| `captureBaseline` | `{ connection, directory?, namespace?, schemas?, onWarning? }` | `{ id, upPath }` |
| `adoptBaseline` | Database tool options | `['0001']` or `[]` |

Database tool options are `{ connection, directory?, namespace? }`, defaulting
to `migrations` and `public`. They accept the same string/config/pool connection
forms as the runtime. `captureBaseline` specifically takes a native libpq
connection string. Tools release their connections and close only pools they own.
`generateDefinitions` returns source without writing files; the CLI writes
atomically. Warning callbacks receive strings and default to `console.warn`.

Public types include `Database`, `Transaction`, `SqlClient`, `TenonOptions`,
`OperationDefinition`, `OperationRegistry`, `OperationClient`,
`OperationReturnMode`, `ResultOptions`, `QueryResult`, `DatabaseToolOptions`,
`SqlMigration`, `MigrationStatus`, `CreateMigrationOptions`, `CreatedMigration`,
`GenerateOptions`, `CaptureBaselineOptions` and `CapturedBaseline`.

`TenonError` describes Tenon's validation and cardinality failures. Native pg
errors pass through execution with their fields intact. Migration failures add
file/direction context and preserve the underlying cause; earlier files may have
committed. If a transaction and its rollback both fail, an `AggregateError`
preserves both errors. Handle errors explicitly and inspect PostgreSQL codes
where application behavior depends on them.

## Work on Tenon

See [contributing](https://github.com/kequtech/tenon-orm/blob/main/docs/contributing.md)
for setup and tests,
[design decisions](https://github.com/kequtech/tenon-orm/blob/main/docs/design-decisions.md)
for settled boundaries, and the
[roadmap](https://github.com/kequtech/tenon-orm/blob/main/docs/roadmap.md) for gaps.
Agent effectiveness, performance at scale and production fault handling still
need evidence. There is no claim of superiority over plain pg plus generated types.
