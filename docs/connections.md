# Connections and driver access

`createTenon` uses a pgclear connection pool. Tenon includes the driver; a separate installation is
needed only when your application imports native pgclear APIs directly.

## Configure a database instance

```ts
import { createTenon } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');

export const db = createTenon({
  connection: {
    connectionString: connection,
    maxConnections: 10,
    connectTimeoutMs: 5000,
    acquireTimeoutMs: 5000,
    idleTimeoutMs: 30_000,
    startupParameters: { search_path: 'app,public', TimeZone: 'UTC' },
  },
});
```

`connection` accepts a PostgreSQL URI, pgclear `PoolOptions`, or an existing pgclear `Pool`.
`ConnectionOptions` is Tenon's alias for `PoolOptions`. Object fields override URI settings.
Reuse an instance for each database configuration.

The driver does not load environment variables, `.env`, pgpass, or service files. Tenon CLI commands
read `DATABASE_URL`; application code passes its configuration explicitly. An empty options object
uses localhost:5432, the current OS user and a database with that user's name.

Use `tls: {}` for TLS with certificate and hostname verification using system trust. Supply the
provider's CA or other required TLS settings through pgclear's `tls` options. Preserve the
connection requirements of your deployment. The complete option list is in the installed driver's
`docs/public-api.md`; unknown options reject.

Qualify table names in SQL or set runtime `search_path`. Tooling `namespace` options select the
schema to migrate or generate; they do not configure your application's queries. The example above
assumes an `app` schema already exists.

## Close resources

For a short-lived script, use `try/finally`:

```ts
try {
  // Await database work here.
} finally {
  await db.close();
}
```

For a server, stop accepting work and finish requests before closing the database. A close call
immediately rejects new Tenon work and gives an owned pool a default 5,000 ms grace period. Set
`db.close({ timeoutMs: 1000 })` to change it; `0` requests immediate shutdown. Remaining driver work
and checkouts expire at the deadline. This bounds database resources, not arbitrary JavaScript
callbacks or proof that a remote rollback completed.

The first valid close call fixes the timeout. Concurrent and later calls share its promise and
outcome. Timeout must be an integer from 0 to 2,147,483,647 ms; invalid initial options reject
without closing the instance.

### Use an application-owned pool

When another part of the application already owns a pgclear pool:

```ts
import { createPool } from '@kequtech/pgclear';
import { createTenon } from '@kequtech/tenon-orm';

const pool = createPool(connection);
const db = createTenon({ connection: pool });
// db.native === pool

await db.close(); // Disables this wrapper; pool remains open.
await pool.close(); // The application owns the pool's shutdown.
```

Tenon borrows the supplied pool by identity. Closing the wrapper does not cancel that pool's
outstanding work. Tool APIs that accept `Connection` follow the same ownership rule.

## Choose output conversions

Outputs follow the pool's codec registry. For example, to read int8 as JavaScript bigint and
`timestamptz` as Date:

```ts
import { builtin, createTenon, defaultCodecs } from '@kequtech/tenon-orm';

const codecs = defaultCodecs.with(builtin.int8BigInt).with(builtin.timestamptzDate);
const db = createTenon({ connection: { connectionString: connection, codecs } });
```

These choices apply across the database instance, including callback transactions. Tenon's query
options have no per-query codec override. Input encoders remain separate: a `param(value, codec)`
carries its own encoder, and passing a Date does not select a Date output decoder.

Use `db.generateTypes` with this instance to inherit its read mappings. Pass the same registry
explicitly to `describeQuery` and `checkQueries`; their CLI forms use default codecs. See
[schema types and values](schema-types.md#custom-codecs) for custom representations and Temporal.

## Observe completed queries

```ts
const db = createTenon({
  connection,
  onQuery(event) {
    console.log(event.label, event.durationMs, event.outcome, event.rowCount);
  },
});
```

Set `{ label: 'user-by-email' }` on a query to identify it. `onQuery` receives duration, outcome,
and available command/count/error-code metadata, with no SQL text or bound values. Validation
failures before execution are not observed. Native driver calls and tooling are outside this hook.

Observers are not awaited. A thrown error or rejected observer promise emits a warning and leaves
the query outcome unchanged. A successful query event inside a transaction does not mean the outer
transaction committed. Guarded-call duration includes its commit or rollback work.

## Use native driver features

`db.native` is the actual pgclear pool. Use it for prepared statements, streams, COPY, or held
sessions. For a finished SQL string:

```ts
const result = await db.native.queryClassic('SELECT $1::integer AS value', [42]);
```

Native calls bypass Tenon's result modes, affected-row guards, SQL boundary checks, and `onQuery`.
They do not join a Tenon callback transaction. A callback's `tx` exposes only `query`.

Use the public driver session APIs and release held leases. For example:

```ts
await db.native.withSession(async (session) => {
  const prepared = await session.prepare('SELECT $1::integer AS value');
  try {
    await prepared.query<{ value: number }>([42]);
  } finally {
    await prepared.close();
  }
});
```

Native `query` accepts pgclear's own SQL tag. Tenon's `sql` and `unsafeSql` results belong in
`db.query`; use `queryClassic` for text to avoid needing a second tag. When both tags are used,
import the native one as `pgSql`.

### Listen for notifications

Import `listen` directly from pgclear for a dedicated connection:

```ts
import { listen } from '@kequtech/pgclear';

const listener = await listen(connection, {
  channels: ['users_changed'],
  onNotification: ({ payload }) => console.log(payload),
  reconnect: true,
});
// At shutdown:
await listener.close();
```

A listener has a separate lifetime and is not closed by `db.close()`. Notifications are not replayed
after a disconnection; the application owns its recovery policy.

## Update the driver

Tenon depends on `@kequtech/pgclear: ^0.3.0`, which permits compatible 0.3.x patch updates. With npm:

```sh
npm update @kequtech/pgclear
npm ls @kequtech/pgclear
```

Review the resolved version and lockfile, regenerate affected declarations, and run application
checks before committing. A lockfile keeps its chosen version until updated. Pgclear 0.4 is outside
this range and requires an explicit Tenon compatibility update.

If the application imports pgclear directly, declare it as a dependency with a compatible version
so the package manager can share a copy. See the [changelog](../CHANGELOG.md) when updating Tenon.
