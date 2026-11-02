# Durable jobs

Tenon includes `@kequtech/pgclear-jobs`. Enable its facade with `jobs: true`. This example assumes
a `projects` table with text `id`, text `status` and timestamp `refreshed_at` columns:

```ts
import { createTenon, defineJob, defineWorker, sql } from '@kequtech/tenon-orm';

const db = createTenon({ connection: process.env.DATABASE_URL, jobs: true });
const refreshProject = defineJob<{ projectId: string }>({ name: 'refresh-project' });
const refreshWorker = defineWorker(refreshProject, {
  transactional: true,
  async handler({ projectId }, { tx }) {
    await tx.query(sql`UPDATE projects SET refreshed_at = now() WHERE id = ${projectId}`);
  },
});

const projectId = 'project-123';
await db.transaction(async (tx) => {
  await tx.query(sql`UPDATE projects SET status = 'ready' WHERE id = ${projectId}`);
  await tx.jobs.send(refreshProject, { projectId });
});
```

Imports, definitions and facade access are inert. Jobs defaults to disabled; disabled operations
reject before SQL without affecting an existing transaction. Enabling Jobs installs no storage and
starts no workers.

Put the `JobSpec<Payload>` returned by handler-free `defineJob` in a shared producer contract;
bind its handler with `defineWorker` in the worker process. Submissions snapshot the specification's
execution/retry policy. Worker options add the handler, transaction mode and local concurrency.
Existing inline `defineJob({ name, handler, ... })` definitions remain supported. Runners require
executable definitions through typing and startup validation.

## Storage setup

Generate, review and commit an application migration pair, then apply it with the existing runner:

```sh
npx tenon jobs setup
npx tenon migrate
```

Setup is offline. It uses `migrations.directory` or `--directory` and supports `--config` and
`--database`. Programmatic `createJobsMigration({ directory? })` returns
`{ id, upPath, downPath, created }`; `created: false` identifies an existing generated pair.

The files contain concrete SQL from the installed Jobs package and use Tenon's normal numbering,
transaction runner and checksums. Repeated setup preserves existing files. Keep applied migrations
unchanged; future Jobs schema changes require an application-authored migration. There is no
incremental Jobs migration engine.

Jobs uses one fixed `pgclear_jobs` schema per physical database. The runner's namespace selects
application history and search path, not a separate queue schema; setup does not accept `--namespace`.
Applications sharing a database should choose one owner for its setup migration and runtime grants.
If storage already exists, account for it in application history before applying the creation SQL.
The down migration removes Jobs storage and its data; disabling Jobs does not remove anything.

## Record operations and transactions

`db.jobs` exposes Jobs record operations and the worker runner. `tx.jobs` exposes the record
operations on that transaction, including submissions, inspection, scheduling and cleanup. Options,
results and errors follow the [Jobs API](https://github.com/kequtech/pgclear-jobs/blob/main/docs/api.md).
Transaction scopes cannot start workers or install storage.

Use the supplied `tx` for writes and follow-up submissions that must commit with successful handler
completion. Throwing rolls those changes back. Root `db` calls commit independently, even inside a
handler. Notifications from transactional submissions become visible on commit.

Tenon's `defineJob`, `defineWorker`, `JobDefinition<Payload>`, `JobOptions<Payload>`,
`WorkerOptions<Payload>` and `TransactionalHandlerContext` use the ORM `Transaction`. Record operations also accept native Jobs
definitions; runners require definitions matching their handler transaction type. Jobs error classes
are re-exported unchanged.

ORM execution retains affected-row savepoints, result modes, serialization, scope expiry and
`onQuery` observation. Producer SQL, handler ORM queries and transactional completion are observed.
Claims, heartbeats and maintenance use pgclear directly; use driver telemetry for that traffic.

See [reliable job workflows](job-workflows.md) for durable results, atomic follow-ups, external effects
and keyed concurrency.

## Workers and shutdown

```ts
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
try {
  await db.jobs.run([refreshWorker], { signal: stop.signal });
} finally {
  await db.close();
}
```

`db.jobs.run(definitions, options?)` forwards Jobs' runner options and lifetime promise. Jobs owns
claims, retries, schedules, cancellation and cleanup. Each run is independently controlled; missing
or incompatible storage rejects startup rather than installing it.

In an HTTP framework startup hook, start the runner, observe rejection immediately, and retain
its promise for shutdown; do not await the worker lifetime from that hook. The optional `onReady` callback
runs once after storage validation, before dispatch, maintenance or listener startup. Its returned
promise is awaited; failures reject the runner. It signals startup, while ongoing health and restart
policy belong to application supervision. Shutdown can interrupt pending readiness work; asynchronous
callbacks should honor the application's shutdown signal.

On shutdown, abort the runner signal, await its promise, then close the database. `db.close()` does
not stop or await workers, and supplied pools remain application-owned. Graceful shutdown allows
accepted work to finish until Jobs' grace expires. Pass handler signals to cancellable dependencies
and leave pool capacity for queue operations alongside application queries and handler transactions.

## Observation and hosting

`db.jobs.run` forwards Jobs' `onEvent` and `onHandlerError` options unchanged. `onEvent` reports
local, best-effort lifecycle observations; observer failures cannot change job outcomes.
`onHandlerError` receives the original handler error after any managed rollback and explicitly chooses
`continue` or `stop`. Jobs owns these semantics; see the
[Jobs API reference](https://github.com/kequtech/pgclear-jobs/blob/main/docs/api.md#observation-and-error-policy).

The [small HTTP host](../examples/jobs-host.ts) demonstrates readiness, worker supervision and
ordered cleanup with a transactional ORM query. It has no application tables or submission routes.
After installing Jobs storage through the migrations above, copy it into an ESM application:

```sh
cp node_modules/@kequtech/tenon-orm/examples/jobs-host.ts ./jobs-host.ts
DATABASE_URL=postgresql://localhost/example node jobs-host.ts
```

It listens on localhost port 3000 (`PORT` overrides this); requests return 200 when ready or 503
while starting/stopping. SIGINT/SIGTERM stops the worker and closes the HTTP server and database.
In this checkout, build first and run `node examples/jobs-host.ts`.
