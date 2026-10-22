import { Pool } from 'pg';
import type { PoolConfig, PoolClient, QueryResult } from 'pg';
import { TenonError } from './errors.js';
import { record } from './sql.js';
import type { Statement } from './sql.js';
import type { Database, Transaction } from './types.js';
import { createOperation, inspectOperations, operationResult } from './operations.js';
import { validateTransactionSql } from './transaction-sql.js';
import type { EmptyOperations, OperationDefinition, OperationRegistry, ResultOptions } from './operations.js';

type Row = Record<string, unknown>;
interface Session {
  query(statement: Statement): Promise<QueryResult<Row>>;
}
export interface TenonOptions<O extends OperationRegistry = EmptyOperations> {
  readonly connection: string | PoolConfig | Pool;
  readonly operations?: O;
}

export default function tenon<const O extends OperationRegistry = EmptyOperations>(options: TenonOptions<O>): Database<O> {
  for (const key of Object.keys(record(options, 'Tenon options'))) {
    if (key !== 'connection' && key !== 'operations') throw new TenonError(`Unknown Tenon option: ${key}`);
  }
  const operations = inspectOperations(options.operations ?? {});
  const ownsPool = !(options.connection instanceof Pool);
  const pool = options.connection instanceof Pool ? options.connection : new Pool(typeof options.connection === 'string' ? { connectionString: options.connection } : options.connection);
  let closed = false;
  function checkOpen() { if (closed) throw new TenonError('This database instance is closed.'); }
  async function transaction<T>(work: (session: Session) => Promise<T>): Promise<T> {
    checkOpen();
    const client: PoolClient = await pool.connect();
    let active = true;
    let releaseError: Error | undefined;
    const session: Session = {
      async query(statement) {
        if (!active) throw new TenonError('The transaction has finished.');
        const config = { text: statement.text, values: [...statement.values], queryMode: 'extended' };
        return client.query<Row>(config);
      },
    };
    try {
      await client.query('BEGIN');
      const result = await work(session);
      // The callback owns this scope; commit must not accept new tx work.
      active = false;
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') throw new TenonError('PostgreSQL rolled back the aborted transaction.');
      return result;
    } catch (error) {
      active = false;
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('Rollback failed.');
        throw new AggregateError([error, rollbackError], 'Transaction and rollback failed.');
      }
      throw error;
    } finally {
      active = false;
      client.release(releaseError);
    }
  }
  const session: Session = {
    async query(statement) {
      checkOpen();
      // Extended protocol makes even a zero-parameter operation one statement.
      const config = { text: statement.text, values: [...statement.values], queryMode: 'extended' };
      return pool.query<Row>(config);
    },
  };
  const db = clientForOperations<O>(operations, session);
  return Object.assign(db, {
    transaction: <T>(callback: (tx: Transaction<O>) => Promise<T>) => transaction(session => callback(clientForOperations<O>(operations, session))),
    async close() {
      if (closed) return;
      closed = true;
      if (ownsPool) await pool.end();
    },
  }) as Database<O>;
}

function clientForOperations<O extends OperationRegistry>(operations: ReadonlyMap<string, OperationDefinition>, session: Session): Transaction<O> {
  async function execute(name: string, operation: OperationDefinition, input: readonly unknown[]): Promise<object | undefined> {
    if (!Array.isArray(input)) throw new TenonError('SQL input must be an explicit array.');
    validateTransactionSql(operation.sql, name);
    const result = await session.query({ text: operation.sql, values: input });
    return operationResult(name, operation, result);
  }
  return {
    async sql(sql: string, input: readonly unknown[], options?: ResultOptions) {
      return execute('Inline SQL', createOperation(sql, options), input);
    },
    async run(name: string, input: readonly unknown[]) {
      const operation = operations.get(name);
      if (!operation) throw new TenonError(`Unknown operation: ${name}`);
      return execute(name, operation, input);
    },
  } as Transaction<O>;
}
