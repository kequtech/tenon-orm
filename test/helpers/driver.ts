import type { TestContext } from 'node:test';
import type postgres from 'postgres';
import type { QueryResult } from '../../src/connection.js';

export function result(
  command = 'SELECT',
  count: number | null = 0,
  rows: object[] = [],
): QueryResult {
  return Object.assign(rows, { command, count, columns: [] }) as unknown as QueryResult;
}

/** A controllable native driver boundary for transaction and cleanup failures. */
export function mockDriver(
  t: TestContext,
  execute: (text: string) => Promise<QueryResult> = async (text) => result(text.split(' ')[0]),
) {
  const release = t.mock.fn();
  const discard = t.mock.fn();
  const end = t.mock.fn(async () => {});
  const options = {
    types: {},
    parsers: {},
    onclose: (_id: number) => {},
    debug: false as postgres.ParsedOptions['debug'],
  };
  async function dispatch(text: string) {
    if (typeof options.debug === 'function') options.debug(1, text, [], []);
    if (text.startsWith('SELECT 1 /* tenon_session_')) return result();
    text = text.replace(/ \/\* tenon_session_\d+ \*\/$/, '');
    if (text.includes('pg_terminate_backend')) {
      discard();
      return result();
    }
    return execute(text);
  }
  function unsafe(text: string) {
    const pending = dispatch(text);
    return Object.assign(pending, { execute: () => pending });
  }
  const reserved = Object.assign(
    async (strings: TemplateStringsArray) => unsafe(strings.join('')),
    { unsafe, release, array: (value: unknown[]) => value, typed: (value: unknown) => value },
  ) as unknown as postgres.ReservedSql;
  const reserve = t.mock.fn(async () => reserved);
  const sql = Object.assign(async () => [], {
    unsafe,
    reserve,
    end,
    options,
    array: (value: unknown[]) => value,
    typed: (value: unknown) => value,
  }) as unknown as postgres.Sql;
  return { sql, reserved, release, discard, end, reserve };
}
