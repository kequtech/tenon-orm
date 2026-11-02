# Getting started

[All guides](../README.md) · [Queries](queries.md) · [Reference](reference.md)

This walkthrough creates one table, writes a reusable query and verifies a guarded transaction.
Use Node.js 24+, PostgreSQL 16+, TypeScript 6+ and ESM. You need an existing database; Tenon does
not create databases or load `.env` files.

## Working in an existing application

Read its database module, `tenon.config.*`, query functions, migration runner, generated types and
check scripts. Preserve those conventions and connections. Start with [queries](queries.md) when
the application is already configured; there is no requirement to adopt Tenon's migration runner.
For an upgrade, read the [changelog](../CHANGELOG.md) from the installed version to the target.

## Connect

Install with the application's package manager:

```sh
npm install @kequtech/tenon-orm
npx tenon init
```

`init` writes `tenon.config.ts` without opening a connection or overwriting configuration:

```ts
// tenon.config.ts
import type { TenonConfig } from '@kequtech/tenon-orm';

export const main = {
  connection: { connectionString: process.env.DATABASE_URL },
  migrations: { directory: 'migrations', namespace: 'public' },
  generate: { out: 'src/generated-schema.d.ts' },
  check: { project: 'tsconfig.json' },
} satisfies TenonConfig;
```

Supply `DATABASE_URL` through your existing environment setup. For a local database:

```sh
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/your_database
```

```ts
// src/db.ts
import { createTenon } from '@kequtech/tenon-orm';
import { main } from '../tenon.config.ts';

export const db = createTenon(main);
```

The examples use Node's native TypeScript support and `.ts` imports. Keep your application's
compiler conventions; for a no-emit NodeNext project, `allowImportingTsExtensions: true` permits
these imports. Emitting projects can use `rewriteRelativeImportExtensions` or their established
`.js` import convention. Supply Node.js development typings and enable strict checking.

Construction is lazy, so a build can import `db` without credentials. Keep database operations out
of module initialization. Reuse the instance across requests; [database hosting](database.md#hosting)
explains cleanup and borrowed pools.

## Create a table

```sh
npx tenon new create_users
```

Fill the generated files:

```sql
-- migrations/0001_create_users.up.sql
CREATE TABLE public.users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);
```

```sql
-- migrations/0001_create_users.down.sql
DROP TABLE public.users;
```

```sh
npx tenon migrate
npx tenon status
```

Make future changes in new files. Applied migrations are immutable and checksum-checked.

## Query and change data

```ts
// src/users.ts
import { sql, type QueryClient } from '@kequtech/tenon-orm';

type User = { id: number; email: string; active: boolean };

export function userByEmail(client: QueryClient, email: string) {
  return client.query(
    sql<User>`SELECT id, email, active FROM public.users WHERE email = ${email}`,
    {
      returns: 'oneOrNone',
    },
  );
}
```

```ts
// src/example.ts
import { sql } from '@kequtech/tenon-orm';
import { db } from './db.ts';
import { userByEmail } from './users.ts';

try {
  await db.query(sql`INSERT INTO public.users (email) VALUES (${'reader@example.test'})
    ON CONFLICT (email) DO NOTHING`);

  await db.transaction(async (tx) => {
    const user = await userByEmail(tx, 'reader@example.test');
    if (!user) throw new Error('User not found');
    await tx.query(sql`UPDATE public.users SET active = false WHERE id = ${user.id}`, {
      affectedRows: { exact: 1 },
    });
  });
  console.log(await userByEmail(db, 'reader@example.test'));
} finally {
  await db.close();
}
```

Run `node src/example.ts`. Every operation intended to commit together uses `tx`. The guard rolls
back the update if its affected count differs. A result mode alone checks returned rows and does
not undo an autocommitted write. See [transactions](queries.md#transactions-and-write-guards).

## Generate and verify

```sh
npx tenon generate
npx tenon generate --check
npx tsc --noEmit
npx tenon check src/users.ts
```

Generation is optional. It reads migrated storage and writes table row/insert/update types. Use
handwritten aliases to select a query's projection:

```ts
import type { Database } from './generated-schema.js';
type User = Pick<Database['users']['row'], 'id' | 'email' | 'active'>;
```

The generated `.js` type import resolves to the `.d.ts` declaration; it loads no runtime module.
`generate --check` compares committed output without rewriting it. In CI, migrate a dedicated test
database, then check freshness before regeneration could hide drift. Commit migrations and reviewed
generated declarations together; production uses the built application and committed output.

Test the query against that test database:

```ts
import assert from 'node:assert/strict';
// db points at dedicated test storage containing this fixture.
const user = await userByEmail(db, 'reader@example.test');
assert.equal(user?.active, false);
```

Also test rollback and authorization paths for changed workflows. Type annotations are declarations;
source checks do not prove result nullability, JSON contents or business invariants. The
[checking guide](checking.md) explains what each tool establishes. Learn [value mappings](types.md#value-mappings)
before choosing types for bigint, decimal, JSON, arrays or timestamps.
