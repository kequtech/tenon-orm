# Changelog

## 0.4.2

- Rewrite the README and consumer guides around a complete getting-started workflow and task-based navigation.
- Add guides for SQL queries, schema types and values, connections, and migrations, including joins, pagination, codec configuration, rollback, and migration recovery.
- Clarify query result modes, write guards, generated types, source checking, and their validation limits. This release changes documentation only; no application migration is required.

## 0.4.1

- Add `db.generateTypes({ out, namespace?, check?, onWarning? })`, using the instance's configured codecs.
- Remove `tenon generate`; run generation and freshness checks from an application script.
  Use the configured database instance, set `check: true` for freshness checks, and close it when
  the script finishes. See the [generation script example](docs/human-guide.md#generate-types).

## 0.4.0

### Breaking changes

- Replace bundled `pg` and `@types/pg` with the `@kequtech/pgclear` runtime dependency (`^0.3.0`).
  Installing Tenon includes the driver; compatible driver patches can update independently.
  Connections accept a PostgreSQL URI, pgclear `PoolOptions`, or a pgclear `Pool`; translate former
  pg configuration and supply deployment settings explicitly.
  PG environment defaults, pgpass/service files, and pg-specific URI options are not read. See
  [connection configuration](docs/connections.md#configure-a-database-instance).
- `db.native` is now a pgclear `Pool`. Use `queryClassic(text, values?)` for finished SQL and
  acquire/withSession for held sessions; native `query` accepts pgclear's own sql tag only. Prepared
  statements, streams, and COPY use the public session APIs. Use pgclear `listen` for dedicated
  notifications. Pool shutdown, transaction outcomes, and savepoint recovery delegate to the driver.
- Command counts remain safe integer numbers; int8/bigserial, SQL count(*) and int8 array elements
  use exact strings. Temporal values and exact numeric arrays are strings, bytes are Uint8Array,
  and result arrays are readonly. JSON/array binds need pgclear json/param or encoded strings.
  Plain bigint, Date, and supported native/polyfilled Temporal inputs use text and server inference;
  output conversions are opt-in. Undefined, plain objects, and arrays reject; mutation-helper
  undefined still omits. JSON encoding still rejects bigint values.
- Tenon owns schema generation and exports `Database[table]['row' | 'insert' | 'update']`.
  Regenerate committed definitions and review write representations. Replace `Rows[table]`,
  `Rows.Insert[table]`, and `Rows.Update[table]` with `Database[table]['row']`,
  `Database[table]['insert']`, and `Database[table]['update']`.
  Catalog queries, schema summaries, defaults/domains/identities, and TypeScript rendering live in
  Tenon; decoder representations come from pgclear. Import generation from Tenon instead of pgclear.
  Tenon retains migration coordination, atomic file output, and `generate --check` freshness checks.

### Added and improved

- Re-export Pgclear parameter/codec helpers and their types through Tenon, so application queries
  and generated declarations use one import path. Use Tenon's `sql` for `db.query`.
- Add optional `tenon check` for a project, file, or file:line, with readable/JSON diagnostics and a
  programmatic `@kequtech/tenon-orm/check` API. Fixed fragments, joins, explicit object shapes, and
  bounded ternaries are checked through pgclear Describe without importing application code or
  executing application SQL. Definite mismatches and unchecked queries fail; inconclusive
  nullability, JSON shapes, decoder types, and refinements remain unproven notes.
- Bundle TypeScript 6 for source checking and load it only on the checking path. Ordinary execution
  continues to trust result annotations; database tests remain necessary for rows and write effects.
- Inspection uses public pgclear Describe with parameter OID hints and a selected codec registry.
  Custom text codecs can declare `text.typescript`; generation and source checking use that metadata,
  including derived arrays, without duplicate readTypes declarations. Unidentified custom decoders
  remain unresolved. Migrations, generation, and inspection use public pgclear sessions without a
  private protocol adapter. Catalog reads keep default decoding on the application's borrowed session.
- Clarify the documentation reading path, common failures, optional patch checking, and the roles of
  source checking, SQL inspection, and generated-file freshness. Keep historical driver reviews out
  of the published consumer docs.

## 0.3.1

- Expand documentation for driver configuration, transaction result adapters, value mappings, and
  validation between persistence representations and application domain values.

## 0.3.0

- **Breaking:** `pg@8.23.1` replaces Postgres.js. Use pg `PoolConfig` (`connectionString` for a URI)
  or `pg.Pool`; removed `{ url, options }` and `ConnectionUri`. `db.native` is the actual pool;
  results use `rows`, `rowCount`, and `fields`, and error fields use pg names (`table`,
  `constraint`). Native LISTEN uses checked-out clients with application-owned resubscription.
  Default results are no longer iterable: use `result.rows`, replace metadata `count` with
  `rowCount`, and update recording helpers. Selected SQL columns named `count` are unchanged. See
  [transaction adapters](docs/reference.md#adapting-transactional-results) for `{ rows }` consumers.
- Driver defaults apply, including no acquisition timeout and SQL null for bound `undefined`. The
  parameter ceiling now matches PostgreSQL's 65,535 limit.
- Regenerate types: temporal reads include numeric infinities, date-only values use Node's local
  timezone, and numeric arrays contain numbers that can lose precision. JSON write inputs are
  encoded strings; use `JSON.stringify`, especially for arrays and strings. Removed `JSONValue`.

## 0.2.2

- Closing a Tenon-owned client through `db.close()` prevents native LISTEN reconnects from restoring
  connections after shutdown, including pending subscription setup. Borrowed clients retain
  application ownership.
- Added `connection: { url, options? }` to preserve a deployment URI while configuring the native
  driver. `ConnectionUri` is exported; `ConnectionOptions` includes the pinned driver's constructor
  `onnotify` callback. Internally created clients remain Tenon-owned.
- Inspection accepts explicit `undefined` for optional session and timeout settings, including in
  strict TypeScript configurations; unknown keys and invalid defined values still fail.
- `db.close({ timeoutMs? })` now shares one shutdown outcome across concurrent/later callers and
  defaults to a 5,000 ms grace period before requesting owned driver termination; `0` skips the
  wait.
- Added `CardinalityError` for `one`/`oneOrNone` mismatches, with code `TENON_CARDINALITY_MISMATCH`,
  expected mode, actual count, and optional label.

## 0.2.1

- Added readonly `db.native` access to Tenon's existing Postgres.js client for LISTEN, cursors,
  COPY, and other native features without another driver installation. Native calls use the pool
  directly and bypass Tenon's query guards and observation; transaction clients expose only `query`.
- Connection ownership is unchanged: `db.close()` ends owned clients and their listeners, while
  borrowed clients remain usable until their owner ends them.

## 0.2.0

Changes since 0.1.0, including improvements shipped in 0.1.1–0.1.4.

### Breaking changes

- Tenon includes `postgres@3.4.9` as its only runtime dependency. Removed `pg`, `@types/pg`, and
  driver peer requirements. Connections accept a PostgreSQL URI, Postgres.js options, or an existing
  Postgres.js client.
- Native results are row arrays with `count`, `command`, and `columns` metadata. Replace
  `result.rows` with the result itself, `rowCount` with `count`, and `fields` with `columns`. The
  `many`, `oneOrNone`, and `one` result modes remain available. Native error fields use Postgres.js
  names such as `table_name` and `constraint_name`.
- Value conversions follow Postgres.js defaults: undefined parameters reject, JSON inputs use native
  JavaScript values, numeric arrays return strings, and timestamp infinities return invalid `Date`
  objects. Pre-serialized JSON text becomes a JSON string.
- Removed the `/safeql` entry point, `safeqlPlugin`, `eslintPlugin`, and their dependencies and peer
  requirements. Tenon no longer checks or fixes SQL result annotations automatically.

### Added

- `describeQuery({ connection, query, session?, timeouts? })` and `tenon describe <query.sql>`
  report PostgreSQL parameter/result types, source columns, a conservative row declaration, and
  unresolved findings. Inspection accepts completed dynamic SQL, uses a separate session, and
  supports explicit role, search path, timezone, and timeouts. It does not execute the query or
  verify its TypeScript annotation. See [query inspection](docs/query-inspection.md).
- `sql.insertValues(input, columns?)` builds inserts with database defaults for missing or undefined
  cells. `sql.assignments(input, columns?)` builds updates that omit undefined fields. Both preserve
  explicit null. See the [mutation cookbook](docs/mutations.md).
- Generated `Rows.Insert['table']` and `Rows.Update['table']` types account for defaults,
  nullability, domains, generated columns, and driver input representations.

### Fixes and improvements

- SQL NULL array elements remain JavaScript null; quoted `"NULL"`, escapes, nesting, and custom
  parsers retain their meanings.
- Transactions and migration locks reject work after connection loss. Failed recovery discards the
  affected session, and accepted pending work finishes before transaction cleanup.
- Large fragment composition avoids argument-spread failures. Queries reject more than 65,533 bound
  parameters before execution; batching remains application-controlled.
- PostgreSQL `name` columns generate string types. `tenon generate --check` reports missing files
  and a short diff for stale definitions without modifying the saved file.
