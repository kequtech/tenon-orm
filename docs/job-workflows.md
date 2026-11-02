# Reliable application job workflows

Jobs owns queue reliability. Applications own business operation identity, durable results and
effects outside the supplied transaction.

## Choose the transaction boundary

Use `transactional: true` for short database work that should commit with successful completion.
Use the handler's supplied `tx` for application writes and follow-up submissions. Model functions
that perform those writes should accept a `Transaction` or the smaller `QueryClient` capability they
need. Open transactions in the caller rather than adapting a transaction into a full `Database`.

A nontransactional handler can prepare external results and use short explicit `db.transaction`
blocks for persistence. Those blocks commit independently of queue completion. If the worker fails
between that commit and completion, a retry must recognize the already committed business operation.

Keep remote generation, email delivery and object-storage work outside long transactions. A
transactional handler holds a connection and acquired locks throughout its execution. Pass
`context.signal` to cancellable dependencies and use idempotency for external effects.

## Persist a result and its follow-up together

Give each business request a durable application ID. A distinct queue job for the same request can
still occur; queue UUID deduplication lasts only while its queue record is retained. Store the
business result reference in application tables so it survives queue pruning.

For example, assume an application request table has `id`, `project_id` and nullable `note_id`, and
`notes` stores the generated text. `projectAnalysis` below is an application-defined job:

```ts
import { defineJob, sql } from '@kequtech/tenon-orm';

const storeNote = defineJob({
  name: 'store-note',
  transactional: true,
  async handler(payload: { requestId: string; noteId: string; text: string }, { tx }) {
    const request = await tx.query(
      sql<{ project_id: string; note_id: string | null }>`
        SELECT project_id, note_id FROM generation_requests
        WHERE id = ${payload.requestId} FOR UPDATE`,
      { returns: 'one' },
    );
    if (request.note_id !== null) return;

    await tx.query(sql`INSERT INTO notes (id, project_id, body)
      VALUES (${payload.noteId}, ${request.project_id}, ${payload.text})`);
    await tx.query(
      sql`UPDATE generation_requests SET note_id = ${payload.noteId}
      WHERE id = ${payload.requestId}`,
      { affectedRows: { exact: 1 } },
    );
    await tx.jobs.request(
      projectAnalysis,
      { projectId: request.project_id },
      {
        key: request.project_id,
      },
    );
  },
});
```

The request row serializes duplicate business requests. The Note, result reference, follow-up and
successful completion commit together. An exception rolls them back together. For large prepared
results, persist a checkpoint and submit its ID rather than copying the result into a job payload;
commit that checkpoint and its finalization submission together.

If persistence commits independently, retain a durable follow-up obligation and reconcile it on
retry. Finding the primary result alone does not prove its required follow-up was submitted. Writes
intended to record business failure also roll back when a transactional handler throws; persist
that status deliberately outside the rejected transaction.

## Uncertain commits and external effects

A rejected commit does not prove rollback: PostgreSQL may have committed while its response was
lost. Tenon preserves `PGCLEAR_COMMIT_UNKNOWN` and aggregate cleanup errors. Infrastructure failures
from opening, committing or cleaning up a Jobs-managed transaction reject the runner. Confirmed
handler exceptions follow normal retry policy after rollback. Errors from an independent transaction
inside a nontransactional handler also follow that handler's retry policy, so it may run again after
an independent commit. Use the runner's `onHandlerError` policy to inspect the original error and
explicitly stop when application supervision should handle it; see [Jobs error policy](https://github.com/kequtech/pgclear-jobs/blob/main/docs/api.md#observation-and-error-policy).

Keep stable operation IDs and storage keys outside the transaction. Reconcile uncertain outcomes
through a healthy connection to the authoritative database before retrying or compensating. In
particular, a transaction's catch block must not unconditionally delete an uploaded object that a
committed row may reference. If reconciliation is unavailable, retain it for later orphan cleanup
and preserve the infrastructure error.

For delivery, persist the application envelope and reuse a provider idempotency key where supported.
Database fencing cannot undo an external effect. Retain application state for the required
reconciliation window, independently of queue history.

## Keyed work, schedules and capacity

Definition and runner concurrency limits apply per runner. `concurrency: 1` does not serialize
independent jobs across processes. A durable schedule limits its own outstanding occurrences;
a manual keyed request and a scheduled occurrence do not automatically share an execution key.

When all entry points must serialize, route them through the same definition and request key. A
small scheduled dispatcher can call `tx.jobs.request(work, payload, { key })`; startup and batch
follow-ups use that same key. A key orders valid claims. An expired handler can still execute
JavaScript, so the application operation must remain safe under repetition.

`request` replaces pending payloads in database serialization order. It does not merge fields or
preserve a sticky force flag. Preserve force intent and debounce timing in application-owned state,
serializing the state change and submission in one transaction. A started head retains its retries;
a new request becomes a trailing successor rather than interrupting that attempt budget.

Reserve capacity for short work alongside long jobs using per-definition limits or separate runs.
The shared pool also serves HTTP queries, claims, renewals and maintenance. Transactional handlers
need additional pool headroom; replacing separate pools with one shared pool changes that budget.

## Policy and application reads

`maxAttempts` includes the first attempt, and timing options use milliseconds. Saved execution and
retry policy is not rewritten when a definition changes. Retry backoff and blocked successors both
appear as `pending`.

`find` defaults to 100 records. Filter and paginate with the last record's cursor, or read durable
application request/result state for a business UI. Queue history pruning releases job-ID
deduplication; application result records should survive it.

See [the Jobs guide](jobs.md) for setup, runner supervision and ORM observation, and the
[Jobs API](https://github.com/kequtech/pgclear-jobs/blob/main/docs/api.md) for exact record semantics.
