# API and CLI reference

[All guides](../README.md) · [Queries](queries.md) · [Database](database.md) · [Jobs](jobs.md)

[Configuration](#configuration) · [Query API](#query-api) · [Errors](#errors) ·
[Tools](#tools) · [Jobs](#jobs) · [Commands](#commands)

## Configuration

`createTenon(config: TenonConfig): Database` accepts one database config. Construction is lazy;
unknown keys reject. [Configuration workflows](database.md#configuration) describe discovery and
pool ownership. `ConnectionOptions` aliases pgclear PoolOptions.

| Field                | Default / contract                                                            |
| -------------------- | ----------------------------------------------------------------------------- |
| connection           | Required at use; URI, pool options or borrowed pool                           |
| onQuery              | Optional, best-effort runtime query observer                                  |
| migrations.directory | migrations beside config (programmatic default: working directory)            |
| migrations.namespace | public; history/lock scope and default generation namespace                   |
| generate.out         | Required if generate section is present; CLI --out can supply output          |
| generate.namespace   | migrations.namespace, then public                                             |
| baseline.connection  | Native libpq URI for pg_dump; falls back to string main connection            |
| baseline.schemas     | Whole database when omitted; explicit list must be nonempty                   |
| check.project        | tsconfig.json beside config                                                   |
| check.readTypes      | Fallback TypeScript expressions for unidentified decoders only                |
| session              | Inspection overrides: role, searchPath, timeZone                              |
| timeouts             | Inspection connectMs:3000, statementMs:5000, lockMs:1000; positive integer ms |

Inspection applies these bounded timeouts over runtime startup settings, then explicit session/CLI
overrides; it does not alter runtime queries or migrations. Programmatic checking/Describe accept
connection values and codecs but do not borrow application transaction sessions.

`QueryEvent` has durationMs, outcome (`success`/`error`) and optional label, command, rowCount and
errorCode. It excludes SQL/values. Pre-execution validation failures emit no event; observer
throws/rejections warn and never change query outcomes.

## Query API

| Member / function                            | Contract                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| db.query(query, options?)                    | Execute one Tenon SqlQuery                                                   |
| db.transaction(callback, options?)           | Return callback result after commit; roll back escaping errors               |
| db.jobs                                      | Record operations and worker startup                                         |
| db.native                                    | Exact pgclear pool; initializes lazy connection                              |
| db.close({timeoutMs?}?)                      | Disable wrapper, close owned pool; default 5000 ms; borrowed pool stays open |
| tx.query / tx.jobs                           | Operations on the supplied expiring transaction; no runner or close          |
| sql<Row> tag                                 | Complete statement with separately bound values                              |
| identifier(...names)                         | Quote approved components; 1–63 UTF-8 bytes each, no NUL                     |
| unsafeSql<Row>(text, values)                 | Trusted finished SQL and explicit values array                               |
| sql.fragment tag                             | Nonblank immutable partial SQL, cannot execute alone                         |
| sql.join(fragments, separator)               | Nonempty fragments; AND, OR or comma; no implicit parentheses                |
| sql.insertValues<Input>(rowOrRows, columns?) | Column/value fragment; empty batches reject                                  |
| sql.assignments<Input>(patch, columns?)      | Assignment fragment; empty assignments reject                                |

`QueryClient` is the capability for reusable query functions accepting db or tx. `Transaction` is
the supplied query/jobs scope. Do not widen either into Database when it owns no lifecycle/pool.
See [query composition and transactions](queries.md) for actual workflows.

| QueryOptions field | Contract                                                          |
| ------------------ | ----------------------------------------------------------------- |
| returns            | native (default), many, oneOrNone or one                          |
| affectedRows       | Exactly one of {exact:n} or {max:n}; nonnegative safe integer     |
| signal             | Optional AbortSignal for this query                               |
| timeoutMs          | Integer 0–2147483647 ms from invocation; zero expires immediately |
| label              | Optional diagnostic/observation label                             |

| returns   | Result                                                | Cardinality |
| --------- | ----------------------------------------------------- | ----------- |
| native    | QueryResult<Row> with rows, rowCount, command, fields | Any         |
| many      | readonly Row[]                                        | Any         |
| oneOrNone | Row or undefined                                      | Zero or one |
| one       | Row                                                   | Exactly one |

Modes add no SQL or rollback by themselves. Write guards apply to final INSERT/UPDATE/DELETE/MERGE
counts, use a root transaction or callback savepoint and roll back before rejecting. Counts exclude
additional trigger/cascade/CTE effects. `TransactionOptions` forwards pgclear signal, timeoutMs,
isolation, readOnly and deferrable. Lifetime timeouts include acquisition/execution/commit; callbacks
are never automatically retried. Close timeout accepts integers 0–2147483647; first valid call wins.

Tenon re-exports builtin, json, param, defaultCodecs, createTemporalCodecs and their value/codec types
from pgclear. [Types and values](types.md) owns encoding/decoding details. No native pgclear SQL tag
is re-exported. Use queryClassic for finished SQL passed to a native executor.

## Errors

| Error                            | Code / fields                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| CardinalityError                 | TENON_CARDINALITY_MISMATCH; expected:one/oneOrNone, actual, optional label                            |
| AffectedRowsError                | TENON_AFFECTED_ROWS_MISMATCH / TENON_AFFECTED_ROWS_UNSUPPORTED; expected, actual:number/null, command |
| Config/composition validation    | Ordinary Error                                                                                        |
| Driver / server errors           | Original pgclear error / PostgreSQL SQLSTATE                                                          |
| Concurrent work/cleanup failures | AggregateError preserving original errors                                                             |

`findDriverErrors(error)` is directly re-exported from pgclear. It returns original driver errors
through causes/aggregates, preserving operation evidence. The driver's
[error guide](https://github.com/kequtech/pgclear/blob/17fae30540cbc41ce2c776645437c6d265e2de96/docs/errors.md) owns traversal, outcomes,
cancellation and recovery. Tenon's [error workflow](queries.md#errors) shows it at the ORM boundary.

Common diagnoses: alias duplicate selected columns; choose string for default int8/count output;
encode JSON/arrays explicitly; branch/skip empty patches; restore immutable applied migrations;
review unchecked reasons rather than cast them away; configure direct/session pooling for tooling
locks. Expired transaction handles never become usable again.

## Tools

Programmatic APIs take explicit options and never discover config:

| API                                                                                     | Result / options                                                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| generateDefinitions({connection, namespace?, onWarning?})                               | Promise<string>; generated declarations, no filesystem handling                                |
| describeQuery({connection, query, codecs?, session?, timeouts?})                        | QueryDescription: context, parameters, columns, rowType, issues                                |
| checkQueries({connection, project?, target?, codecs?, session?, timeouts?, readTypes?}) | CheckReport: ok, project, queries, diagnostics, coverage, optional context; import from /check |
| inspectSchema({connection, namespace?})                                                 | SchemaSnapshot: formatVersion:1, postgresMajor, namespace, metadata collections, fingerprint   |
| migrate({connection, directory?, namespace?})                                           | Applied IDs                                                                                    |
| migrationStatus({connection, directory?, namespace?})                                   | {applied, pending} ID arrays                                                                   |
| rollback({connection, directory?, namespace?, steps?})                                  | Reverted IDs; steps default 1, positive safe integer                                           |
| createMigration({name, directory?})                                                     | {id, upPath, downPath} empty pair                                                              |
| readMigrations(directory?)                                                              | Validated {id, name, up, down?, checksum} records                                              |
| captureBaseline({connection, directory?, namespace?, schemas?, onWarning?})             | {id, upPath}; native libpq connection, schema-only pg_dump                                     |
| adoptBaseline({connection, directory?, namespace?})                                     | Newly recorded IDs, without executing baseline SQL                                             |
| createJobsMigration({directory?})                                                       | {id, upPath, downPath, created}; preserves existing setup pair                                 |

Tool defaults are directory migrations and namespace public. Migration/generation/schema tools
accept borrowed pools and preserve their ownership. Describe/checking instead use separate sessions
from connection values. A finished Describe statement can supply parameter OID hints but values are
never executed. [Checking](checking.md) owns coverage, uncertainty and fingerprint scope;
[database](database.md#migrations) owns migration locking, file rules and baseline adoption.

## Jobs

Tenon re-exports defineJob/defineWorker with ORM Transaction types. JobSpec, saved policy,
record/schedule types, RunnerOptions/RunnerHandle and original engine errors come from pgclear-jobs.
The [Tenon walkthrough](jobs.md) shows setup, submissions and handlers; the
[engine reference](https://github.com/kequtech/pgclear-jobs/blob/25a01a15a6ff28fbbdda6e30e79606b686a26a35/docs/reference.md) owns exact
queue signatures, fields, defaults, events and errors. Those guides ship with the dependency.

| Tenon surface                       | Binding                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| defineJob / defineWorker            | Inert producer specifications and executable handlers; transactional context uses ORM Transaction |
| db.jobs / tx.jobs                   | Jobs record methods on the exact root/transaction scope, with Tenon lifetime checks               |
| db.jobs.run(definitions,options?)   | Native engine lifetime promise; options forwarded                                                 |
| db.jobs.start(definitions,options?) | Native ready/done handle; options forwarded                                                       |
| createJobsMigration({directory?})   | Copy canonical installation SQL into an app migration pair; existing files remain unchanged       |

Record methods include send, sendMany, request, get, getMany, find, stats, attempts, update,
reschedule, cancel, retry, remove, prune, schedule, schedules and unschedule. Transaction scopes
cannot start workers/install storage. A closed database rejects run and throws from start before
starting work; expired transaction record facades reject even empty batches. Root db calls inside
handlers commit independently of their supplied tx.

Tenon applies its query guards/result modes/onQuery to ORM execution. The engine owns claims,
leases, retries, schedules, observation and shutdown. db.close does not await workers; applications
supervise and await them first. See Jobs' [hosting](https://github.com/kequtech/pgclear-jobs/blob/25a01a15a6ff28fbbdda6e30e79606b686a26a35/docs/hosting.md)
and [storage](https://github.com/kequtech/pgclear-jobs/blob/25a01a15a6ff28fbbdda6e30e79606b686a26a35/docs/storage.md) guides for detailed
lifecycle, upgrades and grants.

## Commands

Commands other than docs accept `--config path`; configured databases accept `--database export`. Paths on
flags resolve from the working directory; configured paths resolve beside config. Unsupported flags
reject. Config modules are trusted Node imports. No command automatically loads `.env`.

```text
tenon docs [--json]
tenon init [--config path]
tenon new <name> [--directory migrations]
tenon jobs setup [--directory migrations]
tenon schema [--namespace schema]
tenon generate [--out path] [--namespace schema] [--check]
tenon migrate [--directory migrations] [--namespace public]
tenon status [--directory migrations] [--namespace public]
tenon rollback [--directory migrations] [--namespace public] [--steps 1]
tenon baseline capture [--directory migrations] [--namespace public] [--schema name ...] [--connection native-uri]
tenon baseline adopt [--directory migrations] [--namespace public]
tenon check [file.ts[:line]] [--project tsconfig.json] [--json] [--verbose]
  [--role name] [--search-path value] [--time-zone value]
  [--connect-timeout-ms 3000] [--statement-timeout-ms 5000] [--lock-timeout-ms 1000]
tenon describe <query.sql> [--role name] [--search-path value] [--time-zone value]
  [--connect-timeout-ms 3000] [--statement-timeout-ms 5000] [--lock-timeout-ms 1000]
```

docs resolves installed documentation without configuration or a database. Status emits JSON applied/pending; schema emits snapshot JSON; Describe emits metadata JSON.
Generation writes atomically, or compares without writing with --check. Checking emits readable
findings/counts or JSON. Successful operations exit 0; invalid input/failed operations exit 1. Checking
also fails mismatches, unchecked or zero sites; unproven alone does not fail. Describe can succeed
with unresolved findings. There is no migration dry-run command.
