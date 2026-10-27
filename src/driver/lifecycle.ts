import type postgres from 'postgres';

export interface Watch {
  failure?: Error;
  check(): void;
  closed: Promise<never>;
  reject(error: Error): void;
}
interface State {
  acquiring: Set<(error: Error) => void>;
  active: Map<number, Watch>;
  capture(marker: string, watch: Watch): () => void;
}
const states = new WeakMap<postgres.Sql, State>();
function disconnected(): Error {
  return Object.assign(new Error('The reserved PostgreSQL connection closed.'), {
    code: 'CONNECTION_CLOSED',
  });
}

/** Observe the driver's public connection callbacks; never reuse a reconnected transaction. */
export function observeConnections(sql: postgres.Sql): State {
  const previous = states.get(sql);
  if (previous) return previous;
  const markers = new Map<string, Watch>();
  let debug: postgres.ParsedOptions['debug'] = sql.options.debug;
  // Capture the bootstrap connection ID, then restore debug before application work.
  // Leaving it enabled would make the driver include SQL and values in enumerable errors.
  const captureDebug: Exclude<postgres.ParsedOptions['debug'], boolean> = (
    id,
    text,
    values,
    types,
  ) => {
    const watch = markers.get(text);
    if (watch) {
      state.active.set(id, watch);
      markers.delete(text);
    }
    if (!markers.size) sql.options.debug = debug;
    if (typeof debug === 'function') debug(id, text, values, types);
  };
  const state: State = {
    acquiring: new Set(),
    active: new Map(),
    capture(marker, watch) {
      if (!markers.size) {
        debug = sql.options.debug;
        sql.options.debug = captureDebug;
      }
      markers.set(marker, watch);
      return () => {
        markers.delete(marker);
        if (!markers.size) sql.options.debug = debug;
      };
    },
  };
  const onclose = sql.options.onclose;
  sql.options.onclose = (id) => {
    const error = disconnected();
    const watch = state.active.get(id);
    if (watch) {
      watch.failure ??= error;
      watch.reject(watch.failure);
    }
    for (const reject of state.acquiring) reject(error);
    onclose?.(id);
  };
  states.set(sql, state);
  return state;
}
