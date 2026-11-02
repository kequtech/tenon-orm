# Durable background jobs

[All guides](../README.md) · [Database hosting](database.md#hosting) · [Reference](reference.md#jobs)

[Storage and grants](#storage-and-grants) · [Contracts and workers](#contracts-and-workers) ·
[Submit and inspect](#submit-and-inspect) · [Keys and schedules](#keys-and-schedules) ·
[Hosting](#hosting) · [Reliable application workflows](#reliable-application-workflows)

Tenon includes pgclear-jobs. `db.jobs` and `tx.jobs` are always available; access and definitions
are inert. Storage installation and worker startup are explicit. Transaction scopes expose record
operations only, while database scopes can also start workers.

## Storage and grants

For a new installation:

```sh
npx tenon jobs setup
npx tenon migrate
```

Setup copies the installed Jobs package's concrete up/down SQL into a numbered app migration pair.
It works offline with the configured directory and recognizes existing setup files without changing
them. Review/commit SQL and apply it through the existing runner; storage is never installed on
startup. `migrations.namespace` controls application history, not queue isolation. Jobs uses the
fixed `pgclear_jobs` schema. If it already exists, account for its installation before applying
creation SQL. Applications sharing one database need one setup owner and deliberate grants.

### Upgrading from Jobs 0.2.0

Jobs 0.2.1 uses storage version 2 for scheduled request keys. Stop old producers and workers,
await worker cleanup, and apply a **new** app migration containing `jobsUpgrade.up` from
`@kequtech/pgclear-jobs/migrations`. Keep the original installation pair unchanged. The SQL checks
version 1 and adds the nullable schedule key without resetting records. Then restart all components
using Jobs 0.2.1. Old/new workers reject incompatible storage; mixed-version operation is unsupported.
Setup and `migrate up` do not perform this upgrade automatically.

`jobsUpgrade.down` restores version 1 only after keyed schedules have been removed or converted.
It preserves jobs but cannot undo effects already produced. The supporting package's installed
`docs/migrations.md` explains the upgrade and includes the exported SQL contract.

Run schema DDL as its owner and application operations as a separate runtime role:

```sql
GRANT USAGE ON SCHEMA pgclear_jobs TO jobs_runtime;
GRANT SELECT ON pgclear_jobs.schema_version TO jobs_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON pgclear_jobs.jobs, pgclear_jobs.attempts,
  pgclear_jobs.schedules TO jobs_runtime;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pgclear_jobs FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgclear_jobs.request_job(uuid, text, jsonb, text,
  timestamptz, double precision, jsonb, boolean) TO jobs_runtime;
```

Create the role and its application-table grants through existing provisioning. Runtime needs no
schema CREATE or ownership. Trigger functions need no direct runtime EXECUTE grant. The supporting
package ships this tested recipe as `examples/runtime-grants.sql`. Producer-only roles can omit
attempts privileges/DELETE and schedule privileges when unused. Job names do not isolate tenants or
applications; use database grants as the authorization boundary. Down SQL drops the whole queue
schema and its data; it is not an upgrade method.

## Contracts and workers

Keep producer imports independent of worker implementations:

```ts
// jobs.ts — safe for producers to import
import { defineJob } from '@kequtech/tenon-orm';
export const refresh = defineJob<{ projectId: string }>({
  name: 'refresh-project',
  maxAttempts: 3,
  executionTimeoutMs: 300000,
});
```

```ts
// workers.ts
import { defineWorker, sql } from '@kequtech/tenon-orm';
import { refresh } from './jobs.ts';

export const refreshWorker = defineWorker(refresh, {
  transactional: true,
  concurrency: 2,
  async handler({ projectId }, { tx }) {
    await tx.query(sql`UPDATE public.projects SET refreshed_at = now() WHERE id = ${projectId}`, {
      affectedRows: { exact: 1 },
    });
  },
});
```

This assumes `public.projects(id text, refreshed_at timestamptz)` exists. Producer specifications
own saved retry/execution policy. Workers add handler, transaction mode and local concurrency;
`defineWorker` infers payload and ORM `Transaction`. Existing inline defineJob handlers also work.
Only executable definitions can run. See [reference options](reference.md#jobs).

Transactional handler writes, follow-up submissions, attempt success and completion commit together
when made through the supplied tx. A handler exception rolls them back before retry bookkeeping;
loss of ownership prevents stale completion. A root db call commits independently. Nontransactional
handlers receive id, one-based attempt, saved maxAttempts, signal and nullable scheduledFor.
Pass the signal to cancellable dependencies; cancellation cannot stop arbitrary JavaScript.

## Submit and inspect

```ts
await db.transaction(async (tx) => {
  await tx.query(sql`UPDATE public.projects SET status = 'ready' WHERE id = ${projectId}`);
  await tx.jobs.send(refresh, { projectId });
});
```

This adds a text status column to the preceding table assumption. Submissions and notifications
become visible with the application commit. Payloads are JSON primitives, dense arrays and plain
objects; undefined object fields are omitted. Dates, bigint, nonfinite numbers, cycles/accessors and
undefined array elements reject. Payload types do not validate persisted/untrusted data.

`send` creates independent work, optionally with a stable UUID. Reusing an ID returns its first
record unchanged while retained, even after completion. `sendMany` inserts up to 1000 entries,
skipping duplicate IDs and returning only inserted rows without order guarantees. Empty input is inert.
Use delayMs or runAt for timing, never both; relative delay uses the database clock.

Use `getMany(ids)` for status projection: one bounded statement, original request order, duplicate
IDs returned once and missing IDs omitted. Mixed IDs return unknown payloads. Empty input performs
no SQL but still checks the Tenon facade's lifetime. For larger filtered lists, paginate completely:

```ts
let after: string | undefined;
for (;;) {
  const page = await db.jobs.find(refresh, { limit: 100, ...(after ? { after } : {}) });
  if (!page.length) break;
  for (const job of page) await projectStatus(job); // Application projection.
  after = page.at(-1)!.cursor;
}
```

`find` defaults to 100 records, maximum 1000. Cursors preserve database timestamp precision and
remain valid after cursor-row removal. This is live pagination, not a frozen snapshot. Queue records
are operational state; durable product results belong in application tables. `cancel` only cancels
pending work, including backoff/successors; it does not abort a running provider call.

## Keys and schedules

```ts
await db.jobs.request(refresh, { projectId }, { key: projectId });
await db.jobs.schedule(
  refresh,
  { projectId },
  {
    cron: '0 * * * *',
    key: `hourly:${projectId}`,
    requestKey: projectId,
    timeZone: 'UTC',
  },
);
```

A request key is scoped to the definition. It replaces an unstarted head's payload; after any
attempt starts, requests preserve that head and its retries and coalesce into one trailing successor.
Terminal head transition releases the successor atomically. Omitted timing preserves existing due
times; explicit timing replaces them. Payloads replace rather than merge; sticky force/debounce
intent belongs in application state, serialized with submission.

Schedule `key` identifies the recurring producer; `requestKey` selects shared keyed execution.
With requestKey, each due tick performs the same request without a timing override, so it cannot
postpone a pending head/successor or disturb retry backoff. With no requestKey it creates an ordinary
schedule-owned occurrence, suppressing overlap for that schedule. Different ordinary schedules and
manual keyed requests are independent; per-runner concurrency does not serialize them globally.

Shared jobs have null scheduleId/scheduledFor because several schedules/manual requests may
contribute. Each schedule's lastJobId records the affected job. Unscheduling stops future ticks and
leaves submitted jobs intact; retries follow normal key arbitration. Changing requestKey affects
future ticks, while unchanged cron/timezone preserves the due cursor. Missed ticks submit at most
one saved occurrence/request and advance into the future. Cron is deterministic five-field syntax;
previewSchedule calculates future occurrences without a database.

A key orders valid claims, not external effects from an expired handler. Keep operations safe under
repetition. Reserve capacity for short jobs with definition limits/separate runs; concurrency is
local per runner. The shared pool must also serve requests, claims, renewals and maintenance.

## Hosting

```ts
const stop = new AbortController();
const worker = db.jobs.start([refreshWorker], { signal: stop.signal });
// Attach supervision immediately; stopApplication is application-owned.
void worker.done.catch(stopApplication);
await worker.ready;
// Framework startup can now return while worker.done remains supervised.
// On shutdown: stop accepting requests, then:
stop.abort();
await worker.done;
await db.close();
```

`start` returns ready/done from the same Jobs runner as `db.jobs.run`, whose return value remains
the full lifetime promise. Ready resolves after storage validation and successful onReady, before
dispatch/maintenance/listener startup. It proves no ongoing health or listener connectivity. Startup
errors reject both promises with the original error. A pre-aborted signal or shutdown before readiness
rejects ready with AbortError and normally resolves done. A later failure rejects done. Both promises
are observed immediately, but the host must supervise done and preserve failures during cleanup.

The application owns process signals and restart policy. Abort stops new claims, lets accepted work
finish until shutdown grace expires, then aborts handler scopes. Await done before closing the database;
db.close does not stop workers. Borrowed pools remain application-owned.

The runnable [HTTP host](../examples/jobs-host.ts) demonstrates readiness responses and ordered
cleanup without application tables. Copy it outside node_modules, install storage, set DATABASE_URL
and run `node jobs-host.ts`. It listens on localhost:3000, with PORT override.

### Next.js and framework-owned process exit

A framework can handle SIGTERM and exit without awaiting another asynchronous signal callback.
Host Next and the worker in separate supervised child processes. The parent owns signals, forwards
shutdown, observes either child's failure, awaits worker cleanup and returns a failing exit status
when needed. Keep database ownership in the worker process; startup must not await its full lifetime.

The [Next.js host example](../examples/next-host.mjs) runs a production Next app plus an application
worker entry point. The [worker entry example](../examples/jobs-worker.ts) illustrates the small IPC
readiness contract. Both children stay supervised after readiness. The examples include a bounded
shutdown; a framework process cannot terminate the worker's pool cleanup. See comments for invocation.
This is application hosting code, not a framework runtime dependency or a library process manager.

## Reliable application workflows

Keep remote generation, delivery and object storage outside long transactions. A transactional handler
holds its connection/locks for its entire callback. A nontransactional handler can prepare results
and use short independent transactions, but retry must recognize any result already committed before
queue completion. Use stable business operation IDs and application records that survive queue pruning.
Persist a result reference and its required follow-up in the same short transaction. Finding a result
alone does not prove a separately committed follow-up exists.

A lost COMMIT response can mean success. Keep IDs/storage keys outside the transaction and reconcile
through a healthy connection before repeating effects or deleting uploaded objects. Retain uncertain
objects for later orphan cleanup if reconciliation is unavailable. Provider idempotency keys help
external delivery, but database fences cannot make an external effect exactly once.

`onEvent` is local best-effort observation, not a durable business event stream; observer failures
cannot change outcomes. `onHandlerError` sees an original escaping handler error after confirmed
managed rollback and chooses continue or stop. Continue preserves saved retry policy; stop rejects
the runner with the original error before failure bookkeeping and leaves recovery to the lease engine.
It is escalation, not a durable queue pause. Managed infrastructure failures bypass this hook.

Independent transaction failures inside a nontransactional handler normally follow handler retry
policy; use findDriverErrors and an explicit onHandlerError decision when supervision must reconcile
uncertain outcomes first. Preserve raw errors while choosing safe log metadata. JobError with
retry:false marks permanent failure; retryAt sets a lower bound without extending attempt budget.
Completed/cancelled retention defaults to seven days; failures need explicit pruning. Queue ID
retention is not durable business idempotency. [Reference](reference.md#jobs) lists operations and hooks.
