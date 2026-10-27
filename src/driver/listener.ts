import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import type postgres from 'postgres';

// The driver documents socket factories but omits them from its published types.
type SocketFactory = (options: postgres.ParsedOptions) => Duplex | Promise<Duplex>;
type SocketOptions = postgres.ParsedOptions & { socket?: SocketFactory | undefined };

function closedError() {
  return Object.assign(new Error('The owned PostgreSQL listener is closed.'), {
    code: 'CONNECTION_ENDED',
  });
}

/** Prevent an owned LISTEN client's queued reconnect from reopening it after shutdown. */
export function guardListenerShutdown(sql: postgres.Sql): () => void {
  const options: SocketOptions = sql.options;
  const listen = sql.listen;
  const sockets = new Set<Duplex>();
  let closed = false;
  let hostIndex = 0;

  function track(socket: Duplex) {
    // TLS adoption removes raw socket listeners; prune those closed transports on reconnect.
    for (const previous of sockets) if (previous.destroyed) sockets.delete(previous);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closed) {
      socket.destroy();
      throw closedError();
    }
    return socket;
  }

  sql.listen = (...args) => {
    if (closed) return Promise.reject(closedError());
    const previous = options.socket;
    // Postgres.js synchronously clones these options for its dedicated max:1 listener.
    // Restore immediately so ordinary queries retain their native transport configuration.
    options.socket = (settings) => {
      if (closed) throw closedError();
      if (previous) return Promise.resolve(previous(settings)).then(track);
      const host = settings.host[hostIndex]!;
      const port = settings.port[hostIndex]!;
      const socket = createConnection(settings.path ? { path: settings.path } : { host, port });
      if (!settings.path) {
        hostIndex = (hostIndex + 1) % settings.port.length;
        // The driver's TLS negotiation uses this metadata for SNI and verification.
        Object.assign(socket, { host, port });
      }
      // Node buffers startup writes while connecting; the driver retains its connect timeout,
      // authentication, TLS negotiation and reconnect handling.
      return track(socket);
    };
    try {
      return listen(...args);
    } finally {
      options.socket = previous;
    }
  };

  return () => {
    closed = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
}
