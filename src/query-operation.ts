import { DriverError, type OperationOptions } from '@kequtech/pgclear';

export function queryOperation(options: OperationOptions) {
  const timeout = options.timeoutMs;
  const controller = timeout === undefined ? undefined : new AbortController();
  const expire = () =>
    controller?.abort(new DriverError('PGCLEAR_TIMEOUT', 'Query deadline expired.'));
  const end = timeout === undefined ? Infinity : performance.now() + timeout;
  const timer = timeout === undefined ? undefined : setTimeout(expire, timeout);
  const signals = [options.signal, controller?.signal].filter((s): s is AbortSignal => !!s);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  return {
    options(): OperationOptions | undefined {
      return signal
        ? {
            signal,
            ...(timeout !== undefined && {
              timeoutMs: Math.max(0, Math.ceil(end - performance.now())),
            }),
          }
        : undefined;
    },
    check() {
      if (performance.now() >= end) expire();
      if (signal?.aborted) throw queryAbortError(signal);
    },
    close() {
      clearTimeout(timer);
    },
  };
}

export type QueryOperation = ReturnType<typeof queryOperation>;

function queryAbortError(signal: AbortSignal): DriverError {
  return signal.reason instanceof DriverError &&
    ['PGCLEAR_TIMEOUT', 'PGCLEAR_ABORTED'].includes(signal.reason.code)
    ? signal.reason
    : new DriverError('PGCLEAR_ABORTED', 'Query aborted.');
}

/** Cancel waiting in Tenon's policy queue without interrupting the operation ahead of it. */
export function queryTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(queryAbortError(signal));
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(queryAbortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
      else resolve();
    });
  });
}
