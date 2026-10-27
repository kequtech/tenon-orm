import type postgres from 'postgres';
import type { SqlConnection } from '../connection.js';
import { prepareArrays } from './array.js';
import { observeConnections, type Watch } from './lifecycle.js';
import type { UnknownRow } from '../query.js';

let nextLease = 0;

/** Pin a healthy session for transactions and advisory locks, with explicit failure cleanup. */
export async function reserveConnection(
  sql: postgres.Sql,
  initial: 'SELECT 1' | 'BEGIN' = 'SELECT 1',
) {
  await prepareArrays(sql);
  const state = observeConnections(sql);
  // Warm a connection before reserve(): 3.4.9 can strand a cold reserve after reconnect.
  await sql`SELECT 1`;
  let abandoned = false;
  let rejectAcquisition!: (error: Error) => void;
  const closed = new Promise<never>((_, reject) => {
    rejectAcquisition = reject;
  });
  state.acquiring.add(rejectAcquisition);
  const pending = sql.reserve();
  void pending.then(
    (client) => {
      if (abandoned) client.release();
    },
    () => {},
  );
  let client: postgres.ReservedSql;
  try {
    client = await Promise.race([pending, closed]);
  } catch (error) {
    abandoned = true;
    throw error;
  } finally {
    state.acquiring.delete(rejectAcquisition);
  }
  let rejectClosed!: (error: Error) => void;
  const closedSession = new Promise<never>((_, reject) => {
    rejectClosed = reject;
  });
  void closedSession.catch(() => {});
  const watch: Watch = {
    closed: closedSession,
    reject: rejectClosed,
    check() {
      if (watch.failure) throw watch.failure;
    },
  };
  const safe: SqlConnection = {
    async unsafe<Rows extends object[] = UnknownRow[]>(
      text: string,
      input: postgres.ParameterOrJSON<never>[] = [],
      options?: postgres.UnsafeQueryOptions & { simple?: boolean },
    ) {
      watch.check();
      // Driver dispatch runs in the next microtask, before another socket event.
      const query = client.unsafe<Rows>(text, input, options).execute();
      return Promise.race([query, watch.closed]);
    },
    array: client.array,
    typed: client.typed,
  };
  const connection = {
    sql: safe,
    check: watch.check,
    async release(discard = false) {
      for (const [id, active] of state.active) if (active === watch) state.active.delete(id);
      if (watch.failure) return; // The driver already removed the closed session.
      if (discard) {
        // Failed recovery must not return an unknown transaction/lock state to the pool.
        try {
          await client.unsafe('SELECT pg_terminate_backend(pg_backend_pid())').execute();
        } catch {
          /* The backend closes itself. */
        }
        return;
      }
      client.release();
    },
  };
  // Capture the connection on BEGIN itself when opening a transaction.
  const marker = `${initial} /* tenon_session_${++nextLease} */`;
  const stopCapture = state.capture(marker, watch);
  try {
    await safe.unsafe(marker, [], { simple: false, prepare: false });
    watch.check();
    return connection;
  } catch (error) {
    await connection.release(true);
    throw error;
  } finally {
    stopCapture();
  }
}
