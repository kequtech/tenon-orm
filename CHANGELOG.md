# Changelog

## 0.3.0

- **Breaking:** `pg@8.23.1` replaces Postgres.js. Use pg `PoolConfig` (`connectionString` for a URI)
  or `pg.Pool`; removed `{ url, options }` and `ConnectionUri`. `db.native` is the actual pool;
  results use `rows`, `rowCount`, and `fields`, and error fields use pg names (`table`,
  `constraint`). Native LISTEN uses checked-out clients with application-owned resubscription.
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
