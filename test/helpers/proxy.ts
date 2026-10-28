import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';

/** Interrupt only this test's TCP connections, leaving the database and other tests online. */
export async function postgresProxy(connection: string) {
  const target = new URL(connection);
  const sockets = new Set<Socket>();
  let available = true;
  let paused = false;
  let attempts = 0;
  const server = createServer((client) => {
    attempts++;
    if (!available) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: target.hostname, port: Number(target.port || 5432) });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      socket.on('close', () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
    if (paused) {
      client.pause();
      upstream.pause();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test proxy failed to bind.');
  const url = new URL(connection);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  return {
    connection: url.toString(),
    get attempts() {
      return attempts;
    },
    get sockets() {
      return sockets.size;
    },
    setAvailable(value: boolean) {
      available = value;
      if (!value) for (const socket of sockets) socket.destroy();
    },
    setPaused(value: boolean) {
      paused = value;
      for (const socket of sockets) value ? socket.pause() : socket.resume();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
