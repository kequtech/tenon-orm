# Changelog

## 0.2.0

Changes since 0.1.0, including improvements shipped in 0.1.1–0.1.4.

### Breaking changes

- Tenon includes `postgres@3.4.9` as its only runtime dependency. Removed `pg`, `@types/pg`,
  and driver peer requirements. Connections accept a PostgreSQL URI, Postgres.js options, or
  an existing Postgres.js client.
- Native results are row arrays with `count`, `command`, and `columns` metadata. Replace
  `result.rows` with the result itself, `rowCount` with `count`, and `fields` with `columns`.
  The `many`, `oneOrNone`, and `one` result modes remain available. Native error fields use
  Postgres.js names such as `table_name` and `constraint_name`.
- Value conversions follow Postgres.js defaults: undefined parameters reject, JSON inputs use
  native JavaScript values, numeric arrays return strings, and timestamp infinities return
  invalid `Date` objects. Pre-serialized JSON text becomes a JSON string.
- Removed the `/safeql` entry point, `safeqlPlugin`, `eslintPlugin`, and their dependencies and
  peer requirements. Tenon no longer checks or fixes SQL result annotations automatically.

### Added

- `describeQuery({ connection, query, session?, timeouts? })` and `tenon describe <query.sql>`
  report PostgreSQL parameter/result types, source columns, a conservative row declaration,
  and unresolved findings. Inspection accepts completed dynamic SQL, uses a separate session,
  and supports explicit role, search path, timezone, and timeouts. It does not execute the query
  or verify its TypeScript annotation. See [query inspection](docs/query-inspection.md).
- `sql.insertValues(input, columns?)` builds inserts with database defaults for missing or
  undefined cells. `sql.assignments(input, columns?)` builds updates that omit undefined fields.
  Both preserve explicit null. See the [mutation cookbook](docs/mutations.md).
- Generated `Rows.Insert['table']` and `Rows.Update['table']` types account for defaults,
  nullability, domains, generated columns, and driver input representations.

### Fixes and improvements

- SQL NULL array elements remain JavaScript null; quoted `"NULL"`, escapes, nesting, and custom
  parsers retain their meanings.
- Transactions and migration locks reject work after connection loss. Failed recovery discards
  the affected session, and accepted pending work finishes before transaction cleanup.
- Transactions and standalone guarded writes issue one fewer bootstrap query by registering
  their connection during BEGIN. Cold-start regressions cover concurrent reservations and tooling locks.
- Large fragment composition avoids argument-spread failures. Queries reject more than 65,533
  bound parameters before execution; batching remains application-controlled.
- PostgreSQL `name` columns generate string types. `tenon generate --check` reports missing
  files and a short diff for stale definitions without modifying the saved file.

### Upgrading

1. Remove Tenon's SafeQL imports and plugin configuration, and unused checking dependencies.
2. Install Tenon and remove `pg`/`@types/pg` when no other code needs them. Replace pg-specific
   connection configuration and pools with Postgres.js equivalents.
3. Update native result/error access, pass JSON values directly, and regenerate table definitions.
   Review numeric arrays and date validity. Use generated insert/update types for write inputs.
4. Inspect meaningful query variants and keep database tests for complete rows, permissions,
   ordering, write effects, and rollback. Match inspection settings to the execution session.
