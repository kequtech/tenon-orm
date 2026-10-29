import type { TestContext } from 'node:test';
import { createPool, type Lease, type Transaction } from '@kequtech/pgclear';
import type { QueryResult } from '../../src/connection.js';

export function result(
  command = 'SELECT',
  count: number | null = 0,
  rows: Record<string, unknown>[] = [],
): QueryResult {
  return {
    command,
    commandTag: command,
    rowCount: count,
    rows,
    fields: [],
  };
}

/** A public driver boundary double for Tenon policy/delegation tests, without transport machinery. */
export function mockDriver(
  t: TestContext,
  execute: (text: string) => Promise<QueryResult> = async (text) => result(text.split(' ')[0]),
) {
  const release = t.mock.fn(),
    discard = t.mock.fn(),
    end = t.mock.fn(async () => {});
  let status: 'idle' | 'transaction' = 'idle';
  const query = async (input: string | { text: string }) => {
    const text = typeof input === 'string' ? input : input.text;
    const value = await execute(text);
    if (text === 'BEGIN') status = 'transaction';
    if (text === 'ROLLBACK' || text === 'COMMIT') status = 'idle';
    return value;
  };
  const reserved = {
    queryClassic: query,
    get transactionStatus() {
      return status;
    },
    release: (options?: { discard?: boolean }) => (options?.discard ? discard() : release()),
  } as unknown as Lease;
  const transaction = {
    queryClassic: query,
    savepoint: async (work: (tx: Transaction) => Promise<unknown>) => work(transaction),
  } as unknown as Transaction;
  const reserve = t.mock.fn(async () => reserved);
  const sql = createPool({});
  t.mock.method(sql, 'acquire', reserve);
  t.mock.method(sql, 'queryClassic', query);
  t.mock.method(sql, 'transaction', async <T>(work: (tx: Transaction) => Promise<T>) =>
    work(transaction),
  );
  t.mock.method(sql, 'close', end);
  return { sql, reserved, release, discard, end, reserve, transaction };
}
