import {
  defineJob as nativeDefineJob,
  jobs as nativeJobs,
  runJobs as nativeRun,
} from '@kequtech/pgclear-jobs';
import type { Pool } from '@kequtech/pgclear';
import { createTenon, defineJob, defineWorker, sql } from '../src/index.js';
import type {
  JobDefinition,
  JobOptions,
  JobSpec,
  RunnerEvent,
  RunnerHandle,
  WorkerOptions,
  Transaction,
  TransactionalHandlerContext,
} from '../src/index.js';

// Compile-only consumer contracts for the default Jobs facade.
async function contracts(pool: Pool) {
  const db = createTenon({ connection: pool });
  const specification: JobSpec<{ id: number }> = defineJob<{ id: number }>({ name: 'shared' });
  await db.jobs.send(specification, { id: 1 });
  await nativeJobs(pool).request(specification, { id: 2 }, { key: 'shared' });
  // @ts-expect-error Producer payloads cannot be widened by submissions.
  await db.jobs.send(specification, { id: 'wrong' });
  // @ts-expect-error Producer specifications cannot be executed without a handler.
  await db.jobs.run([specification]);
  const worker = defineWorker(specification, {
    transactional: true,
    async handler(payload, { tx }) {
      await tx.query(sql`SELECT ${payload.id}::int`);
      // @ts-expect-error Integrated workers receive an ORM transaction.
      await tx.queryClassic('SELECT 1');
    },
  });
  const handle: RunnerHandle = db.jobs.start([worker], { signal: AbortSignal.abort() });
  void handle.ready;
  void handle.done;
  const batch = await db.jobs.getMany([]);
  const payload: unknown = batch[0]?.payload;
  void payload;
  // @ts-expect-error Heterogeneous IDs cannot assert a payload type.
  await db.jobs.getMany<{ id: number }>([]);
  await db.jobs.schedule(
    specification,
    { id: 1 },
    { cron: '0 * * * *', key: 'hourly', requestKey: 'shared' },
  );
  const workerOptions: WorkerOptions<{ id: number }> = {
    handler(payload) {
      const id: number = payload.id;
      void id;
    },
  };
  defineWorker(specification, workerOptions);
  // @ts-expect-error A worker cannot change the shared payload contract.
  defineWorker(specification, { handler(payload: { id: string }) {} });
  // @ts-expect-error A worker cannot require fields absent from the shared payload.
  defineWorker(specification, { handler(payload: { id: number; extra: string }) {} });
  // @ts-expect-error Execution policy belongs on the shared specification.
  defineWorker(specification, { handler() {}, maxAttempts: 4 });
  // @ts-expect-error Workers still require executable handlers.
  defineWorker(specification, {});
  await db.jobs.run([worker], {
    onHandlerError(failure) {
      const original: unknown = failure.error;
      const id: string = failure.id;
      void original;
      void id;
      // @ts-expect-error Payloads are excluded from runner error context.
      void failure.payload;
      return 'continue';
    },
    onEvent(event: RunnerEvent) {
      if (event.type === 'attemptFailed') {
        const retryAt: Date | null = event.retryAt;
        void retryAt;
      }
      // @ts-expect-error Events omit payloads.
      void event.payload;
    },
  });
  // @ts-expect-error Native runners cannot supply an ORM worker transaction.
  await nativeRun(pool, [worker]);
  const options: JobOptions<{ id: number }> = {
    name: 'typed',
    transactional: true,
    async handler(payload, context: TransactionalHandlerContext) {
      const tx: Transaction = context.tx;
      const row = await tx.query(sql<{ id: number }>`SELECT ${payload.id}::int AS id`, {
        returns: 'one',
      });
      const id: number = row.id;
      await tx.jobs.send(child, id);
      // @ts-expect-error Native driver execution is not part of an ORM transaction.
      await tx.queryClassic('SELECT 1');
      // @ts-expect-error Transaction scopes cannot start workers.
      await tx.jobs.run([child]);
      // @ts-expect-error Transaction scopes cannot own worker lifetimes.
      tx.jobs.start([child]);
      // @ts-expect-error Transaction scopes cannot install storage.
      await tx.jobs.install();
    },
  };
  const child = defineJob({ name: 'child', handler(_payload: number) {} });
  const def: JobDefinition<{ id: number }> = defineJob(options);
  await db.jobs.send(def, { id: 1 });
  await nativeJobs(pool).send(def, { id: 1 });
  // @ts-expect-error Payload inputs cannot widen definition inference.
  await db.jobs.send(def, { id: 'wrong' });
  // @ts-expect-error Bulk inputs also preserve payload types.
  await db.jobs.sendMany(def, [{ payload: { id: 'wrong' } }]);
  const found = await db.jobs.find(def);
  const id: number | undefined = found[0]?.payload.id;
  void id;
  await db.jobs.run([def, child]);
  // @ts-expect-error Native runners cannot provide the ORM transaction expected by a handler.
  await nativeRun(pool, [def]);
  const native = nativeDefineJob({
    name: 'native',
    transactional: true,
    async handler(_payload: number, { tx }) {
      await tx.queryClassic('SELECT 1');
    },
  });
  // @ts-expect-error ORM runners cannot supply a native driver transaction.
  await db.jobs.run([native]);
  await db.jobs.send(native, 1);
  await db.transaction(
    async (tx) => {
      await tx.jobs.send(def, { id: 1 });
    },
    {
      isolation: 'serializable',
      readOnly: false,
      deferrable: false,
      signal: new AbortController().signal,
      timeoutMs: 1000,
    },
  );
}
void contracts;
