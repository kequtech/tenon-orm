# Background jobs through Tenon

[Overview](../README.md) · [Database hosting](database.md#hosting) · [Reference](reference.md#jobs)

Tenon includes pgclear-jobs and binds its handlers to ORM transactions. Use Tenon imports when
handlers need sql, query guards or onQuery observation. The queue engine also works directly with
pgclear; it owns the detailed [Jobs reference](https://github.com/kequtech/pgclear-jobs/blob/8c50ae294abaf1d70d8e43e4601455e0703f0fee/docs/reference.md).
The matching guides ship in the installed pgclear-jobs package.

## Install storage

```sh
npx tenon jobs setup
npx tenon migrate
```

Setup copies concrete installation SQL into an application-owned numbered migration pair, offline.
Review/commit it and apply it through the existing runner. Repeated setup preserves saved files.
Worker startup validates the installed storage version; it performs no installation or upgrade.
Database/transaction facades are always available and inert; access creates neither storage nor
workers. Transaction facades expose only record operations.

Jobs uses one pgclear_jobs schema per database. Tenon's migrations.namespace selects its own
history/search path, not queue isolation. If Jobs storage is already represented in a captured
baseline or existing migrations, keep that ownership; do not add a second installation migration.
When replacing another queue, transferring any retained jobs is a separate application migration;
setup only installs Jobs storage.

### Upgrade existing storage

Jobs 0.3.0 requires storage version 3. The package exports only jobsMigration.up/down: the canonical
current installation/removal SQL. Compare it with the application's saved Jobs schema and author
any necessary changes as a new application migration. Keep historical files unchanged and preserve
queued work. Stop old producers/workers, apply the reviewed changes, then restart matching packages.

`npx tenon docs` locates the matching installed [storage guide](https://github.com/kequtech/pgclear-jobs/blob/8c50ae294abaf1d70d8e43e4601455e0703f0fee/docs/storage.md).
Setup generates the initial pair only. Existing-storage changes remain application-owned; there is
no upgrade command or exported upgrade migration. If a script imports Jobs SQL directly, declare
the matching pgclear-jobs package as a direct dependency with the application's package manager.

## Define a contract and bind its worker

```ts
// jobs.ts — producers can import this without worker services
import { defineJob } from '@kequtech/tenon-orm';
export const refresh = defineJob<{ projectId: string }>({ name: 'refresh-project' });
```

```ts
// workers.ts
import { defineWorker, sql } from '@kequtech/tenon-orm';
import { refresh } from './jobs.ts';

export const refreshWorker = defineWorker(refresh, {
  transactional: true,
  async handler({ projectId }, { tx }) {
    await tx.query(sql`UPDATE public.projects SET refreshed_at = now() WHERE id = ${projectId}`, {
      affectedRows: { exact: 1 },
    });
  },
});
```

Assume public.projects has text id, text status and timestamptz refreshed_at columns. The payload
and ORM transaction are inferred. Specifications own saved execution/retry policy; worker bindings
add code, transaction mode and local concurrency. Use the supplied tx for writes and follow-ups
that must commit with successful completion. Root db calls commit independently.

## Submit, coalesce and inspect

```ts
await db.transaction(async (tx) => {
  await tx.query(sql`UPDATE public.projects SET status = 'ready' WHERE id = ${projectId}`);
  await tx.jobs.send(refresh, { projectId });
});

await db.jobs.request(refresh, { projectId }, { key: projectId });
await db.jobs.schedule(
  refresh,
  { projectId },
  {
    cron: '0 * * * *',
    key: `hourly:${projectId}`,
    requestKey: projectId,
  },
);
const records = await db.jobs.getMany(jobIds);
```

send creates independent work. request coalesces under a durable definition/key; an unstarted head's
payload is replaced, while started work retains its retries and one blocked successor. The Jobs
reference below provides the request behavior table and timing rules. Scheduled requestKey uses
that execution key; schedule key identifies the producer. getMany avoids per-row lookups; find defaults
to 100 and needs cursor pagination for complete projections. Job history is operational state, so persist business
results separately. The Jobs [reference](https://github.com/kequtech/pgclear-jobs/blob/8c50ae294abaf1d70d8e43e4601455e0703f0fee/docs/reference.md)
and [reliability guide](https://github.com/kequtech/pgclear-jobs/blob/8c50ae294abaf1d70d8e43e4601455e0703f0fee/docs/reliability.md) define
payload validation, timing, keys, pagination, retention and cancellation.

## Cancel work

`await db.jobs.cancel(jobId)` cancels pending work immediately or records a running job's cancellation
request. The worker aborts the handler's existing signal after its next heartbeat; handlers should
pass that signal to external dependencies. The returned running record exposes cancelRequestedAt.
The call does not wait for the handler to stop. Managed writes roll back when cancellation wins;
already committed completion remains completed. The Jobs reliability guide owns detailed cancellation
and successor rules. Cancelling a job does not unschedule its producer or cancel another job.

## Run and close

```ts
await db.jobs.run([refreshWorker]);
```

run runs continuously and returns its lifetime promise. When the application host provides a shutdown
signal, pass it as `{ signal: shutdownSignal }`. One host signal can serve all runners; the engine
handles draining active work. Await the runner before closing the database.

Readiness confirms storage validation and the readiness hook, not notification connectivity or ongoing
health. For readiness, start forwards the engine's ready/done handle; supervise done immediately.
Tenon owns neither process signals nor worker restart policy, and db.close does not
stop workers. Supplied pools remain application-owned. The ORM
[HTTP example](../examples/jobs-host.ts) demonstrates readiness and ordered cleanup with a real ORM
query; the [worker entry](../examples/jobs-worker.ts) shows ORM bindings for a separate worker process.

Jobs owns the generic [hosting guide and Next host](https://github.com/kequtech/pgclear-jobs/blob/8c50ae294abaf1d70d8e43e4601455e0703f0fee/docs/hosting.md).
Copy its process host when a framework controls process exit, and supply your ORM worker entry.
Detailed readiness, hook, cancellation and process behavior belongs there. Tenon forwards RunnerOptions
without reproducing the engine's lifecycle or error classification.

ORM submissions, handler queries and transactional completion retain guards, scope expiry and
onQuery observation. Claims/heartbeats/maintenance use pgclear directly. Keep external work outside
long transactions, persist durable operation/results/follow-ups deliberately and reconcile uncertain
commits before repeating effects. These cross-application patterns are documented in Jobs' reliability
guide. Error objects and engine events are forwarded unchanged.

For stalled work, correlate get/getMany, stats and attempts with onEvent by job ID. The Jobs
[troubleshooting table](https://github.com/kequtech/pgclear-jobs/blob/8c50ae294abaf1d70d8e43e4601455e0703f0fee/docs/hosting.md#troubleshoot-progress)
covers pending work, cancellation, lease loss, deadlines and shutdown grace.
