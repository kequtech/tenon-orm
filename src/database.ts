import { createClient } from './client.js';
import type { QueryExecutor } from './connection.js';
import { createConnection, executeSql, isPool } from './connection.js';
import type { TenonConfig } from './config.js';
import { configConnection } from './config/connection.js';
import { configObject } from './config/validate.js';
import { withTransaction } from './transaction.js';
import type { CloseOptions, Database, Transaction } from './types.js';
import { plainObject } from './validation.js';
import { createJobRecords, jobsIntegration } from './jobs.js';
import type { DatabaseJobs, TransactionJobs } from './jobs.js';

function closeTimeout(options: CloseOptions | undefined): number {
  const settings = plainObject(options === undefined ? {} : options, 'Close options');
  for (const key of Object.keys(settings)) {
    if (key !== 'timeoutMs') throw new Error(`Unknown close option: ${key}`);
  }
  const timeoutMs = settings.timeoutMs === undefined ? 5000 : settings.timeoutMs;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 2147483647
  ) {
    throw new Error('Close timeoutMs must be an integer from 0 to 2147483647 milliseconds.');
  }
  return timeoutMs;
}

export function createTenon(config: TenonConfig): Database {
  configObject(config);
  const onQuery = config.onQuery;
  const jobsEnabled = config.jobs === true;
  let connection: ReturnType<typeof createConnection> | undefined;
  let closing: Promise<void> | undefined;

  function checkOpen() {
    if (closing) {
      throw new Error('This database instance is closed.');
    }
  }

  function checkJobs() {
    checkOpen();
    if (!jobsEnabled) throw new Error('Jobs are disabled. Set jobs: true in the Tenon config.');
  }

  function transactionClient(query: QueryExecutor, checkActive: () => void): Transaction {
    let jobs: TransactionJobs | undefined;
    const tx: Transaction = {
      ...createClient(query, onQuery),
      get jobs() {
        return (jobs ??= createJobRecords(tx, () => {
          checkJobs();
          checkActive();
        }));
      },
    };
    return tx;
  }

  function currentConnection() {
    if (!connection) {
      checkOpen();
      const value = config.connection;
      connection = createConnection(isPool(value) ? value : configConnection(value));
    }
    return connection;
  }

  const query: QueryExecutor = (text, input, readResult, guarded) => {
    checkOpen();
    const { pool } = currentConnection();
    if (guarded) return withTransaction(pool, (query) => query(text, input, readResult, false));
    return executeSql(pool, text, input).then(readResult);
  };

  let jobs: DatabaseJobs | undefined;
  const db: Database = {
    ...createClient(query, onQuery),
    get jobs() {
      return (jobs ??= {
        ...createJobRecords(db, checkJobs),
        run(definitions, options) {
          try {
            checkJobs();
            return jobsIntegration.runJobs(db, definitions, options);
          } catch (error) {
            return Promise.reject(error);
          }
        },
      });
    },
    get native() {
      return currentConnection().pool;
    },
    async transaction(callback, options) {
      checkOpen();
      const { pool } = currentConnection();
      return withTransaction(
        pool,
        (query, checkActive) => callback(transactionClient(query, checkActive)),
        options,
      );
    },
    close(options) {
      if (closing) return closing;
      try {
        const timeoutMs = closeTimeout(options);
        // Cache before invoking driver callbacks, so reentrant/concurrent callers share shutdown.
        closing = Promise.resolve().then(() => connection?.close(timeoutMs));
        return closing;
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  return db;
}
