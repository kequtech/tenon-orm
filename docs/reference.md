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

| QueryOptions field | Contract                                                      |
| ------------------ | ------------------------------------------------------------- |
| returns            | native (default), many, oneOrNone or one                      |
| affectedRows       | Exactly one of {exact:n} or {max:n}; nonnegative safe integer |
| label              | Optional diagnostic/observation label                         |

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

`findDriverErrors(error: unknown): readonly DriverError[]` is directly re-exported from pgclear.
It follows own cause and AggregateError members, root/cause/member order, deduplicates identities,
skips accessors and handles cycles. It returns evidence about individual operations, not a safe-to-retry
or transaction-committed classification. [Error workflows](queries.md#errors) explain reconciliation.
Use structured codes rather than messages, including PGCLEAR_COMMIT_UNKNOWN for uncertain commits.

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

Import defineJob/defineWorker and Jobs types/errors from Tenon for ORM transaction typing.
`defineJob<Payload>({name,...policy})` returns an inert JobSpec. `defineWorker(spec, {handler,
transactional?, concurrency?})` returns an executable definition. Inline definitions with handlers
also work. Name is 1–200 nonblank characters. Payload is strict JSON data, not runtime-validated
against its TypeScript declaration. [Jobs guide](jobs.md) explains workflows and ownership.

| Saved policy       | Default                          |
| ------------------ | -------------------------------- |
| maxAttempts        | 3 total, including first; 1–1000 |
| retryDelayMs       | 1000; 0–86400000                 |
| retryBackoff       | exponential; or fixed            |
| retryMaxDelayMs    | 86400000; zero allowed           |
| retryJitter        | true; half-to-full capped delay  |
| executionTimeoutMs | 300000 per attempt               |

Worker transactional defaults false; concurrency defaults to runner capacity. These are runtime
settings, while submitted policy is saved and unchanged by later definition edits. Context includes
id, attempt, maxAttempts, signal, scheduledFor and tx only for transactional handlers.

| Record operation, on db.jobs or tx.jobs                  | Result / behavior                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| send(spec,payload,{id?,runAt?,delayMs?}?)                | Independent job; stable ID returns original while retained                         |
| sendMany(spec,submissions)                               | Up to 1000 entries; inserted records only, duplicates skipped, no guaranteed order |
| request(spec,payload,{key,runAt?,delayMs?})              | Unstarted head replacement or one coalesced successor                              |
| get(id) / getMany(ids)                                   | Job<unknown>/null, or found records once in first-requested order; batch max 1000  |
| find(spec,{key?,states?,limit?,after?}?)                 | Creation-time/UUID cursor order; default 100, max 1000                             |
| stats(spec)                                              | State counts plus ready, delayed, blocked, total                                   |
| attempts(id,{limit?}?)                                   | Latest first; number, startedAt, finishedAt, outcome, error; default 100, max 1000 |
| update(spec,id,payload) / reschedule(id,runAt)           | Pending records only; preserve policy/history/budget                               |
| cancel(id)                                               | Pending only, including backoff/successor                                          |
| retry(id)                                                | Fresh linked job from failed record; occupied key/schedule rejects                 |
| remove(id)                                               | Terminal only; false if absent; attempts cascade                                   |
| prune(spec,{before,states?,limit?})                      | Bounded terminal cleanup; default completed/cancelled, limit 100, max 1000         |
| schedule(spec,payload,{cron,timeZone?,key?,requestKey?}) | Durable producer; key defaults empty, timezone UTC                                 |
| schedules(spec,{limit?}?) / unschedule(spec,key?)        | List by key or remove producer, leaving submitted work                             |

Job fields: id, name, payload, nullable key/blockedBy, state (pending/running/completed/failed/cancelled),
attempts, saved policy, runAt/createdAt/updatedAt, nullable finishedAt/lastError/scheduleId/scheduledFor/
retryOf, opaque cursor. Schedule fields: id, name, key, nullable requestKey, payload, policy, cron,
timeZone, nextRunAt, nullable lastJobId. Keys accept at most 500 characters, including empty.
Timing accepts either runAt or delayMs, never both. Empty sendMany/getMany perform no SQL.

`previewSchedule({cron,timeZone?},{from?,count?}?)` returns Dates strictly after from; default count 5,
max 100. Five-field deterministic cron only. Unscheduling does not cancel jobs.

`db.jobs.run(definitions, options?): Promise<void>` is the worker lifetime.
`db.jobs.start(definitions, options?): RunnerHandle` exposes ready/done using that same runner.
A closed database rejects run and throws from start before starting work. Neither exists on tx.jobs.
Definitions must be nonempty, executable and uniquely named. Pool shutdown stays application-owned.

| Runner option      | Default / contract                                           |
| ------------------ | ------------------------------------------------------------ |
| signal             | Application-owned shutdown signal                            |
| onReady            | Awaited once after schema validation, before dispatch        |
| concurrency        | 1; 1–1000 unfinished handlers, including cancelled callbacks |
| notifications      | Optional dedicated listener connection; omit for polling     |
| pollIntervalMs     | 1000; 30000 when notifications enabled                       |
| recoveryIntervalMs | 1000                                                         |
| leaseMs            | 30000; min 30, renewed each third                            |
| shutdownTimeoutMs  | 30000; zero allowed                                          |
| databaseTimeoutMs  | 10000                                                        |
| retentionMs        | 604800000; positive safe integer or false; failures retained |
| onEvent            | Best-effort local observation; not awaited                   |
| onHandlerError     | Awaited continue/stop policy for escaping handler errors     |

Other millisecond options accept integers 1–2147483647 unless noted. Runner handles reject ready
on startup failure or pre-ready cancellation (AbortError); done covers final cleanup and later
failures. Readiness is not ongoing health. [Hosting](jobs.md#hosting) gives complete ownership rules.

Events: attemptStarted, attemptCompleted, attemptFailed (original error and saved retryAt),
attemptAbandoned (leaseLost/deadlineExceeded/runnerStopped), runnerFailed (final original/aggregate
error, optional originating attempt). AttemptInfo has id, name, attempt, maxAttempts, scheduledFor.
Events are local/non-durable; observer failures warn with PGCLEAR_JOBS_OBSERVER_FAILED.

HandlerFailure adds error, signal and transactional to AttemptInfo. Continue preserves normal retry;
stop rejects before failure bookkeeping. Managed infrastructure failures bypass the hook. A hook
failure/invalid action aggregates original handler and policy errors. Keep async action literals
strict with `Promise<HandlerErrorAction>` if necessary. JobError accepts retry:false or retryAt,
plus standard cause. JobNotFoundError/JobStateError expose jobId.

## Commands

All commands accept `--config path`; configured databases accept `--database export`. Paths on
flags resolve from the working directory; configured paths resolve beside config. Unsupported flags
reject. Config modules are trusted Node imports. No command automatically loads `.env`.

```text
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
tenon check [file.ts[:line]] [--project tsconfig.json] [--json]
  [--role name] [--search-path value] [--time-zone value]
  [--connect-timeout-ms 3000] [--statement-timeout-ms 5000] [--lock-timeout-ms 1000]
tenon describe <query.sql> [--role name] [--search-path value] [--time-zone value]
  [--connect-timeout-ms 3000] [--statement-timeout-ms 5000] [--lock-timeout-ms 1000]
```

Status emits JSON applied/pending; schema emits snapshot JSON; Describe emits metadata JSON.
Generation writes atomically, or compares without writing with --check. Checking emits readable
findings/counts or JSON. Successful operations exit 0; invalid input/failed operations exit 1. Checking
also fails mismatches, unchecked or zero sites; unproven alone does not fail. Describe can succeed
with unresolved findings. There is no migration dry-run command.
