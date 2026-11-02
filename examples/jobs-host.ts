// Copy outside node_modules in an ESM app. Set DATABASE_URL and install Jobs storage first.
import { createServer } from 'node:http';
import { createTenon, defineJob, defineWorker, sql } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required.');
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT.');
const db = createTenon({ connection });
const stop = new AbortController();
const shutdown = () => stop.abort();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

const query = defineJob<{ value: number }>({ name: 'example:query' });
const worker = defineWorker(query, {
  transactional: true,
  async handler({ value }, { tx }) {
    await tx.query(sql`SELECT ${value}::integer`);
  },
});
let ready = false;
const failures: unknown[] = [];
const record = (error: unknown) => {
  if (!failures.includes(error)) failures.push(error);
};
const server = createServer((_request, response) => {
  const available = ready && !stop.signal.aborted;
  response.writeHead(available ? 200 : 503).end(available ? 'ready' : 'unavailable');
});
server.on('error', (error) => {
  record(error);
  shutdown();
});
try {
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string')
      console.log(JSON.stringify({ listening: `http://127.0.0.1:${address.port}` }));
  });
  // Awaiting here observes the whole worker lifetime while HTTP remains responsive.
  await db.jobs.run([worker], {
    signal: stop.signal,
    onReady() {
      ready = true;
    },
  });
} catch (error) {
  record(error);
} finally {
  shutdown();
  await new Promise<void>((resolve) =>
    server.close((error) => {
      if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) record(error);
      resolve();
    }),
  );
  try {
    await db.close();
  } catch (error) {
    record(error);
  }
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, 'Host shutdown failed.');
