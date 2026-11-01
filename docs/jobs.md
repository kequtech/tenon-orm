# Durable jobs

Tenon includes `@kequtech/pgclear-jobs`. Enable its facade with `jobs: true`:

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

Imports, definitions and facade access are inert. Jobs defaults to disabled; disabled operations
reject before SQL without affecting an existing transaction. Enabling Jobs installs no storage and
starts no workers.

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

Tenon's `defineJob`, `JobDefinition<Payload>`, `JobOptions<Payload>` and
`TransactionalHandlerContext` use the ORM `Transaction`. Record operations also accept native Jobs
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
  await db.jobs.run([refreshProject], { signal: stop.signal });
} finally {
  await db.close();
}
```

`db.jobs.run(definitions, options?)` forwards Jobs' runner options and lifetime promise. Jobs owns
claims, retries, schedules, cancellation and cleanup. Each run is independently controlled; missing
or incompatible storage rejects startup rather than installing it.

An HTTP host should start the runner without awaiting its lifetime from startup registration,
observe rejection immediately, and retain the promise for shutdown. The optional `onReady` callback
runs once after storage validation, before dispatch, maintenance or listener startup. Its returned
promise is awaited; failures reject the runner. It signals startup, while ongoing health and restart
policy belong to application supervision. Shutdown can interrupt pending readiness work; asynchronous
callbacks should honor the application's shutdown signal.

On shutdown, abort the runner signal, await its promise, then close the database. `db.close()` does
not stop or await workers, and supplied pools remain application-owned. Graceful shutdown allows
accepted work to finish until Jobs' grace expires. Pass handler signals to cancellable dependencies
and leave pool capacity for queue operations alongside application queries and handler transactions.
