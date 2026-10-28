import type { TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { Pool, type PoolClient } from 'pg';
import type { QueryResult } from '../../src/connection.js';

export function result(
  command = 'SELECT',
  count: number | null = 0,
  rows: Record<string, unknown>[] = [],
): QueryResult {
  return { command, rowCount: count, rows, fields: [], oid: 0 };
}

/** A controllable pg boundary for transaction and cleanup failures. */
export function mockDriver(
  t: TestContext,
  execute: (text: string) => Promise<QueryResult> = async (text) => result(text.split(' ')[0]),
) {
  const release = t.mock.fn();
  const discard = t.mock.fn();
  const end = t.mock.fn(async () => {});
  const query = async (input: string | { text: string }) =>
    execute(typeof input === 'string' ? input : input.text);
  const reserved = Object.assign(new EventEmitter(), {
    query,
    release: (error?: Error) => (error ? discard(error) : release()),
  }) as unknown as PoolClient;
  const reserve = t.mock.fn(async () => reserved);
  const sql = new Pool();
  t.mock.method(sql, 'connect', reserve);
  t.mock.method(sql, 'query', query);
  t.mock.method(sql, 'end', end);
  return { sql, reserved, release, discard, end, reserve };
}
