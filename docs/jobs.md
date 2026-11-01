# Durable jobs

Tenon includes `@kequtech/pgclear-jobs` alongside pgclear. Enable its facade explicitly:

```ts
import { createTenon, defineJob, sql } from '@kequtech/tenon-orm';

const db = createTenon({ connection: process.env.DATABASE_URL, jobs: true });
const refreshProject = defineJob({
  name: 'refresh-project',
  transactional: true,
  async handler(payload: { projectId: string }, { tx }) {
    await tx.query(sql`UPDATE projects SET refreshed_at = now() WHERE id = ${payload.projectId}`);
  },
});

const projectId = 'project-123';
await db.transaction(async (tx) => {
  await tx.query(sql`UPDATE projects SET status = 'ready' WHERE id = ${projectId}`);
  await tx.jobs.send(refreshProject, { projectId });
});
```

Definitions are inert. Constructing a database or reading `db.jobs` opens no connection. `jobs`
defaults to false; disabled operations reject before SQL or acquisition, including empty batches,
and do not poison an existing transaction. `jobs: true` enables operations without creating storage
or starting workers. Enabling Jobs does not change ordinary queries.

## Storage setup

Generate a normal application migration pair:

```sh
npx tenon jobs setup
npx tenon migrate
```

Setup is offline. It uses `migrations.directory`, or `--directory`, and supports `--config` and
`--database`. The fixed Jobs schema is `pgclear_jobs`; the migration runner's namespace still
selects application history and its search path. Jobs setup does not accept `--namespace`.

Review and commit the generated files. They contain concrete SQL from the installed Jobs package,
including its advisory lock. Tenon's normal scanner, transaction runner and checksums apply.
Repeated setup recognizes the generated pair, including after a package update, and never rewrites
it. Recognition accepts LF/CRLF line endings and an optional UTF-8 BOM without rewriting saved
bytes. Migration history checksums still cover the saved SQL; keep applied files unchanged.
Missing, conflicting or duplicate setup files require review. A successful setup reports the
paths; it does not enable runtime Jobs or apply SQL.

There is no incremental Jobs migration system. If a future Jobs release changes its schema, the
application owner writes a new migration that navigates that change. Existing migrations remain
unchanged. Before upgrading, check Jobs' schema compatibility requirements. Deliberate removal or
reset loses queued work and history; stop producers and workers before applying the down SQL.
`jobs: false` never removes storage.

For a database where Jobs was installed separately or included in a baseline, account for that
existing schema in the application's migration history before applying a generated setup migration.
The setup up SQL creates the schema; it is not an adoption operation. The older `tenon_jobs`
development namespace is not migrated automatically. Applications with another migration runner
can use the concrete SQL pair without transferring migration ownership to Tenon.

Programmatic setup uses `createJobsMigration({ directory? })`, returning
`{ id, upPath, downPath, created }`. `created: false` identifies an existing pair. It needs no
connection or runtime enablement.

## Record operations and typing

`db.jobs` and `tx.jobs` forward Jobs' `send`, `request`, `sendMany`, `get`, `find`, `reschedule`,
`update`, `cancel`, `retry`, `remove`, `prune`, `stats`, `attempts`, `schedule`, `schedules` and
`unschedule` operations. Their payloads, options, results and errors follow pgclear-jobs. `request`
coalesces keyed work; it does not give external business effects exactly-once semantics. See the
[Jobs API](https://github.com/kequtech/pgclear-jobs/blob/main/docs/api.md) for operation details.

Use the supplied `tx` for writes and follow-up submissions that must commit with successful handler
completion. Throwing rolls these changes back. Root `db` calls commit independently, even when
made inside a handler. PostgreSQL notifications from transactional submissions become visible on
commit. Transaction scopes expose record operations, with no worker startup or schema installer.

Tenon's `defineJob`, `JobDefinition<Payload>`, `JobOptions<Payload>` and
`TransactionalHandlerContext` bind transactional handlers to the ORM `Transaction`. Submission
operations also accept native Jobs definitions because they only use definition metadata; workers
must receive definitions matching their transaction type. `JobError`, `JobNotFoundError` and
`JobStateError` are the original Jobs error classes.

Queries retain Tenon's affected-row savepoints, result modes, serialization, expired-scope checks
and `onQuery` observation. Producer SQL, handler ORM queries and transactional completion pass
through Tenon. Claims, heartbeats and maintenance remain native Jobs operations and do not emit
Tenon `onQuery` events; use driver observation for that traffic. Aborted or completed transactions
cannot be reused, including for an empty batch, even if a handler ignores cancellation.

## Workers and shutdown

```ts
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
try {
  await db.jobs.run([refreshProject], { signal: stop.signal });
} finally {
  await db.close();
}
```

`db.jobs.run(definitions, options?)` forwards Jobs' runner options and promise. Observe rejection
through the application's supervision. Jobs owns dispatch, retries, schedules, leases, fencing,
notifications, cancellation, retention and cleanup. Each run is independently controlled. A
pre-aborted runner with valid definitions and options resolves without initializing a pool.
Missing or incompatible storage rejects startup rather than installing it.

An HTTP app should supervise the worker promise, request shutdown, await it, then close the database.
`db.close()` only manages database resources; it does not stop or await workers. A supplied pool
remains application-owned. Graceful shutdown permits accepted work to finish until Jobs' configured
grace expires. Handler signals are cooperative for external work; application code must ensure
business idempotency, payload compatibility across deployments and adequate pool capacity.

Transaction options are also available independently of Jobs:

```ts
await db.transaction(
  async (tx) => {
    await tx.query(sql`SELECT 1`);
  },
  { signal: stop.signal, timeoutMs: 5000, isolation: 'read committed' },
);
```

`TransactionOptions` is pgclear's type. Tenon forwards it through acquisition, execution and commit,
including read-only/deferrable settings. Driver and aggregate errors retain their original identity;
an uncertain commit must be reconciled by the application rather than blindly retried.
