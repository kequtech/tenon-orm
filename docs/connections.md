# Connections and driver access

`createTenon` uses a pgclear connection pool. Tenon includes the driver; a separate installation is
needed only when your application imports native pgclear APIs directly.

## Configure a database instance

Define connection settings in the shared config:

```ts
// tenon.config.ts
import type { TenonConfig } from '@kequtech/tenon-orm';

export const main = {
  connection: {
    connectionString: process.env.DATABASE_URL,
    maxConnections: 10,
    connectTimeoutMs: 5000,
    acquireTimeoutMs: 5000,
    idleTimeoutMs: 30_000,
    startupParameters: { search_path: 'app,public' },
  },
} satisfies TenonConfig;
```

Pass the config to the constructor:

```ts
import { createTenon } from '@kequtech/tenon-orm';
import { main } from '../tenon.config.ts';

export const db = createTenon(main);
```

`createTenon` takes one `TenonConfig` object. Connection validation and pool creation wait until the
first query, transaction, or `db.native` access. The pool connects when it needs a session. Closing an
unused instance does not resolve its connection. Subsequent operations reuse the same pool.

The config's `connection` field accepts a PostgreSQL URI or pgclear pool-option values.
`ConnectionOptions` is Tenon's alias for `PoolOptions`. Object fields override URI settings. A
programmatically constructed config may also supply an existing pool, preserving its ownership.

Keep codecs in `connection.codecs` so runtime and tooling use the same representations. See
[shared configuration](configuration.md) for build-safe environment values and
[multiple databases](configuration.md#multiple-databases) for named exports and CLI selection.

The config supplies environment values to the driver, which does not load `.env`, pgpass, or service
files. An explicitly missing URI fails when the instance is used. Deliberately configuring
`connection: {}` uses the driver's local defaults: localhost:5432, the current OS user, and a database
with that user's name.

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
import { createTenon } from '@kequtech/tenon-orm';
import { pool } from './existing-pool.js';

const db = createTenon({ connection: pool });
// db.native === pool

await db.close(); // Disables this wrapper; pool remains open.
await pool.close(); // The application owns the pool's shutdown.
```

Tenon borrows the supplied pool by identity. Closing the wrapper does not cancel that pool's
outstanding work. Tool APIs that accept `Connection` follow the same ownership rule.

## Choose output conversions

Outputs follow the configured codec registry. To read int8 as JavaScript bigint and `timestamptz` as
Date, set the registry in `tenon.config.ts`:

```ts
import { builtin, defaultCodecs, type TenonConfig } from '@kequtech/tenon-orm';

const codecs = defaultCodecs.with(builtin.int8BigInt).with(builtin.timestamptzDate);
export const main = {
  connection: { connectionString: process.env.DATABASE_URL, codecs },
} satisfies TenonConfig;
```

These choices apply across the database instance, including callback transactions. Tenon's query
options have no per-query codec override. Input encoders remain separate: a `param(value, codec)`
carries its own encoder, and passing a Date does not select a Date output decoder.

The CLI uses that registry for generation, inspection, and checking. Programmatic `describeQuery`
and `checkQueries` inherit codecs from connection-option values too. See
[schema types and values](schema-types.md#custom-codecs) for custom representations and Temporal.

## Observe completed queries

Set `onQuery` on the database config:

```ts
import type { TenonConfig } from '@kequtech/tenon-orm';

export const main = {
  connection: { connectionString: process.env.DATABASE_URL },
  onQuery(event) {
    console.log(event.label, event.durationMs, event.outcome, event.rowCount);
  },
} satisfies TenonConfig;
```

Set `{ label: 'user-by-email' }` on a query to identify it. The observer receives duration, outcome,
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

During application startup, pass a validated PostgreSQL URI (`connection` below) to pgclear's
`listen` for a dedicated notification connection:

```ts
import { listen } from '@kequtech/pgclear';

const listener = await listen(connection, {
  channels: [],
  onNotification: ({ payload }) => console.log(payload),
  reconnect: true,
});
// Membership can change on this same connection. Await server registration:
await listener.subscribe('users_changed');
// When the channel is no longer needed:
await listener.unsubscribe('users_changed');
// At shutdown:
await listener.close();
```

A listener has a separate lifetime and is not closed by `db.close()`. Subscription changes share its
dedicated connection; reconnect restores the current channel membership. Applications own subscriber
counts, authorization, and routing. Notifications are not replayed after a disconnection; use the
listener's status/generation changes to detect a possible gap and reconcile persistent state.

## Update the driver

Tenon depends on `@kequtech/pgclear: ^0.3.3`, which permits compatible 0.3.x patch updates. With npm:

```sh
npm update @kequtech/pgclear
npm ls @kequtech/pgclear
```

Review the resolved version and lockfile, regenerate affected declarations, and run application
checks before committing. A lockfile keeps its chosen version until updated. Pgclear 0.4 is outside
this range and requires an explicit Tenon compatibility update.

If the application imports pgclear directly, declare it as a dependency with a compatible version
so the package manager can share a copy. See the [changelog](../CHANGELOG.md) when updating Tenon.
