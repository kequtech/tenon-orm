# Pgclear job library design handoff

31 October 2026. This captures the direction for an experimental PostgreSQL job library alongside
Tenon and pgclear. The next step is to refine a small public API around the decisions below. A new
library has not been implemented, and this handoff does not authorize creating or publishing one.

The user likes pg-boss and considers it a great tool. The motivation is to explore whether Kequtech
can build a simpler, easier-to-use queue that fits its own database tools. A focused sister library
built on pgclear is the leading proposal. Broad pg-boss compatibility is not the objective.

## The execution boundary

**Jobs run independently. The transaction that inserts a job has no part in executing it.**

The intended sequence is:

1. Application code opens a database transaction.
2. It writes application data and inserts a job record containing the job name and payload.
3. The transaction commits, making the job visible to workers. A rollback leaves no job to run.
4. An independent worker later claims the committed record and runs the predefined handler with
   its payload. The originating transaction and request can be long gone.

The originating transaction, SQL executor, session, closures, and application request are never
serialized into the job, retained for its execution, or passed to its handler. Workers can run in
another process. Shared job behavior is application code, not a function stored in PostgreSQL.

The user repeatedly corrected responses that brought the discussion back to transactions inside
handlers or special transactional workers. Do not reintroduce that design. A handler may use normal
application database code, but the queue does not need to arrange, expose, or coordinate a special
transaction for its execution.

Transaction support concerns application operations on queue records: insertion and, when useful,
reading, editing, cancellation, or deletion. The immediate integration question is simply how the
queue's INSERT can execute through an existing Tenon transaction without depending on Tenon.

## Define behavior once

The user rejected an initial API that separated a job definition from its handler registration and
required several independent pieces to describe one job. The preferred direction is one definition
containing the stable name, handler, and execution policy. Subsequent submissions supply data and
use that same behavior.

An illustrative shape from the conversation is:

```ts
const jobs = createJobs({ connection: pool });

const welcomeEmail = jobs.define({
  name: 'welcome-email',
  maxAttempts: 5,

  async handler({ userId }: { userId: string }) {
    await sendWelcomeEmail(userId);
  },
});

await welcomeEmail.send({ userId: user.id });

// Worker process startup:
await jobs.start();

// Process shutdown:
await jobs.close();
```

These names and signatures are proposals, not an implemented or finalized API. Definition should
not itself start workers or connect to PostgreSQL. A producer can submit work without starting
workers. Application imports should not start processing as a side effect.

Returning from a handler completes the attempt; throwing follows the definition's retry policy.
Behavior such as retries, concurrency, and execution limits belongs in the definition. A submission
can describe when that particular job should run, for example with `runAt`; it should not need to
redeclare the handler or its policy.

## Tenon integration without a dependency

The queue should use pgclear directly and should not require Tenon or its TypeScript tooling as a
runtime dependency. Applications using Tenon must still be able to insert queue records atomically
with their own writes.

The current Tenon transaction exposes `query`, accepting a Tenon SQL object. Tenon's public
`unsafeSql(text, values)` constructs that object from parameterized SQL. These public APIs allow
application code to route a queue statement through the transaction. Using `db.native` inside a
Tenon transaction would use the pool and would not join the callback transaction.

A small SQL execution callback was suggested as the integration boundary: accept SQL text and
bound values and return the query result. It would be used only while executing the producer's
record operation. It must never become persisted job data or an execution facility for the handler.
**The user has not accepted a final adapter API or call syntax.** Do not treat the earlier
`execute` option or `fromTenon` helper as settled decisions.

An enqueue inside an application transaction is an insertion, not an invocation of the handler.
Any notification used to wake workers should commit with that insertion. The queue must not take
ownership of the caller's transaction or execute work through it later.

## Finding and changing existing jobs

The user wants a clear way to find and change previously submitted jobs, potentially within an
application transaction. This is part of managing persisted records and is separate from execution.

Methods such as `get`, `list`, `update`, `reschedule`, `cancel`, `retry`, and `remove` were discussed.
The exact method set, lookup keys, filters, return values, and errors remain open. Storing a returned
job ID on the owning application record was suggested as a simple lookup strategy. Searching by an
application reference may also be useful; no reference-key contract has been chosen.

The proposed initial rule is that payload edits and rescheduling apply to pending jobs. A worker
can claim a job between a read and an update, so the mutation itself must enforce eligibility and
report a conflict. Cancellation and deletion cannot undo effects of a handler that has already run.
Active-job cancellation semantics still need a concrete decision.

## Useful initial capabilities

The discussed use cases were follow-up emails, reminders, report generation, upload processing,
refreshing derived data, external synchronization, and periodic maintenance.

The candidate core is durable submission, delayed execution, bounded retries with backoff, local
worker concurrency, recovery of abandoned claims, inspection of failures, and basic record
management. Deduplication of outstanding work may be useful, but its key lifetime and return
semantics are not settled. Recurring schedules are a useful possible addition, not a confirmed
first-release requirement.

Dependency workflows, RRULE scheduling, multiple database backends, elaborate queue policies,
distributed rate limits, and a dashboard are outside the proposed initial focus. Avoid turning a
small experiment into a broad compatibility project.

## Reliability requirements

A small interface still requires careful implementation:

- Claims must be atomic across concurrent workers, using short database operations such as
  `FOR UPDATE SKIP LOCKED` followed by a state change.
- Each attempt needs a fresh claim token. Completion, failure, and lease renewal must verify that
  token so a stale worker cannot modify a newer attempt.
- Worker loss must lead to recovery after lease expiry. Heartbeat renewal and a maximum execution
  deadline address different failure modes.
- Persistent rows are authoritative. Notifications accelerate discovery; polling recovers missed
  notifications and discovers delayed jobs.
- Retries must terminate in an inspectable failure. Outstanding jobs should not silently disappear
  through an implicit retention policy.
- Cleanup and recovery sweeps need bounded batches, suitable indexes, and short transactions.
- Shutdown must stop new claims and handle unfinished or uncooperative handlers deliberately.
- Enqueue retries must account for uncertain commit outcomes rather than blindly duplicating work.

Execution is at least once. An application write or external action can succeed before the worker
records completion, and a crash can cause another attempt. Handlers need appropriate idempotency.
Do not solve this by adding the special handler transaction API the user rejected.

Operational visibility should expose overdue work, failed jobs, and worker activity. A durable job
can remain unprocessed because workers are absent or its handler keeps failing; persistence alone
does not establish that work is getting done.

## Findings from the feasibility assessment

The initial assessment inspected Tenon 0.4.2, its installed pgclear 0.3.0, a sibling pgclear checkout,
and pg-boss 12.38.0. The Tenon checkout is now 0.4.5 and declares pgclear `^0.3.3`; the earlier probe
results concern the earlier installed versions.

An isolated scratch probe passed on PostgreSQL 16.15 using Tenon and pgclear 0.3.0:

- Enqueueing committed and rolled back with application writes.
- Ten concurrent claim calls returned 100 distinct jobs.
- An expired claim was recovered with a new token; stale completion affected no row.
- Future jobs were excluded from claims.
- A separate experiment demonstrated atomic application writes and completion, including rollback
  after losing a claim. That capability is not the chosen handler design.
- Ordinary pgclear queries rejected multiple statements; `session.script()` returned both results
  for an unbound multi-statement script.

The temporary probe is `/tmp/tenon-queue-feasibility.mjs` and may not survive environment cleanup.
It established feasibility of database primitives, not a production queue. Process-kill tests,
network-failure tests, sustained-load tests, schema-upgrade behavior, and real application use are
still needed before trusting a replacement.

Pg-boss already provides atomic enqueueing, transactional handlers, notification-assisted polling,
and substantial recovery machinery. Those existing capabilities should not be presented as unique
advantages of this experiment. Potential gains are a smaller API, coherent pgclear integration,
typed job definitions, and behavior tailored to Kequtech applications. Performance and reliability
advantages would need evidence.

## Size and maintenance expectations

Earlier planning estimates were 500–1,500 lines of production code for an experimental core and
3,000–6,000 for a dependable focused library. Tests could equal or exceed production code. Broader
scheduling, concurrency, and administrative features could grow the library to 6,000–12,000 or more
lines. These estimates preceded the latest scope clarifications and are not implementation targets.

The expected investment is several weeks of engineering and validation, followed by months of
learning through use. Maintenance was estimated at several days per month during initial adoption,
settling toward a few hours per month with occasional multi-day fixes if the scope remains narrow.
These are rough planning assumptions, not measured commitments. Owning recovery and database
compatibility remains an ongoing responsibility even when the public API is small.

## Next design work

Refine the API using one reminder workflow: define its behavior once, insert its queue record in
the application's transaction, locate and reschedule or cancel the record when application state
changes, and execute it later in an independent worker.

Resolve the producer-side SQL boundary, lookup strategy, mutation restrictions, and return values
before implementing. Keep examples of inserting a record and executing a handler clearly separate.
Do not restart the discussion around sharing an originating transaction with a job.

## Reference material

- [Pg-boss 12.38.0 source](https://github.com/timgit/pg-boss/tree/12.38.0/src)
- [Pg-boss 12.38.0 release](https://github.com/timgit/pg-boss/releases/tag/12.38.0)
- [Pg-boss transaction adapters](https://github.com/timgit/pg-boss/blob/12.38.0/docs/api/adapters.md)
- [Pg-boss attempt fencing tests](https://github.com/timgit/pg-boss/blob/12.38.0/test/attemptFenceTest.ts)
- [PostgreSQL locking clauses](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE)
- Tenon public boundaries: `src/types.ts`, `src/query.ts`, and `docs/connections.md`.
