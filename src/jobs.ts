import { createJobsIntegration } from '@kequtech/pgclear-jobs/integration';
import type { JobsApi } from '@kequtech/pgclear-jobs/integration';
import type { InputValue } from '@kequtech/pgclear';
import type {
  JobDefinition as NativeJobDefinition,
  JobOptions as NativeJobOptions,
  JobRecords,
  RunnerOptions,
  TransactionalHandlerContext as NativeTransactionalHandlerContext,
} from '@kequtech/pgclear-jobs';
import { unsafeSql } from './query.js';
import type { Database, Transaction } from './types.js';

export type JobDefinition<Payload> = NativeJobDefinition<Payload, Transaction>;
export type JobOptions<Payload> = NativeJobOptions<Payload, Transaction>;
export type TransactionalHandlerContext = NativeTransactionalHandlerContext<Transaction>;
/** Only record operations are available inside a transaction. */
export type TransactionJobs = Pick<JobRecords, keyof JobRecords>;
export interface DatabaseJobs extends TransactionJobs {
  run(definitions: readonly JobDefinition<unknown>[], options?: RunnerOptions): Promise<void>;
}

export const jobsIntegration = createJobsIntegration<Database, Transaction>({
  pool: (db) => db.native,
  execute:
    (scope) =>
    <Row extends object>(
      text: string,
      values: readonly InputValue[] = [],
    ): Promise<{ readonly rows: readonly Row[] }> =>
      scope.query<Row>(unsafeSql<Row>(text, values)),
  transaction: (db, work, options) => db.transaction(work, options),
});

export const defineJob: JobsApi<Database, Transaction>['defineJob'] = jobsIntegration.defineJob;

/** Check each operation, including operations such as an empty batch that execute no SQL. */
export function createJobRecords(scope: Transaction, check: () => void): TransactionJobs {
  const records = jobsIntegration.jobs(scope);
  function forward<T>(work: () => Promise<T>): Promise<T> {
    try {
      check();
      return work();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return {
    send: (definition, payload, options) =>
      forward(() => records.send(definition, payload, options)),
    request: (definition, payload, options) =>
      forward(() => records.request(definition, payload, options)),
    sendMany: (definition, inputs) => forward(() => records.sendMany(definition, inputs)),
    get: (id) => forward(() => records.get(id)),
    find: (definition, options) => forward(() => records.find(definition, options)),
    reschedule: (id, runAt) => forward(() => records.reschedule(id, runAt)),
    update: (definition, id, payload) => forward(() => records.update(definition, id, payload)),
    cancel: (id) => forward(() => records.cancel(id)),
    retry: (id) => forward(() => records.retry(id)),
    remove: (id) => forward(() => records.remove(id)),
    prune: (definition, options) => forward(() => records.prune(definition, options)),
    stats: (definition) => forward(() => records.stats(definition)),
    attempts: (id, options) => forward(() => records.attempts(id, options)),
    schedule: (definition, payload, options) =>
      forward(() => records.schedule(definition, payload, options)),
    schedules: (definition, options) => forward(() => records.schedules(definition, options)),
    unschedule: (definition, key) => forward(() => records.unschedule(definition, key)),
  };
}
