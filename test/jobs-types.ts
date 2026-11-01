import {
  defineJob as nativeDefineJob,
  jobs as nativeJobs,
  runJobs as nativeRun,
} from '@kequtech/pgclear-jobs';
import type { Pool } from '@kequtech/pgclear';
import { createTenon, defineJob, sql } from '../src/index.js';
import type {
  JobDefinition,
  JobOptions,
  Transaction,
  TransactionalHandlerContext,
} from '../src/index.js';

// Compile-only consumer contracts; disabled instances retain the same facade types.
async function contracts(pool: Pool) {
  const db = createTenon({ connection: pool });
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
