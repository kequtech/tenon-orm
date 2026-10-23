# Tenon ORM

A PostgreSQL ORM built around SQL, with typed operations, migrations, and generated
TypeScript types. Designed for straightforward use by developers and coding agents.

Write ordinary SQL with bound parameters. Compose queries with explicit fragments,
choose the returned-row contract, and use transactions or affected-row checks for
writes. Your application owns the `pg` driver, connection configuration, and validation.

```sh
npm install @kequtech/tenon-orm pg
```

Requires Node.js 24+, PostgreSQL 16+, and ESM. TypeScript consumers need TypeScript 6+
and development typings for Node and `pg`.

```ts
import { createTenon, sql } from '@kequtech/tenon-orm';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
const db = createTenon({ connection });

const email = 'reader@example.test';
const user = await db.query(
  sql<{ id: number; email: string }>`
    SELECT id, email FROM public."User" WHERE email = ${email}
  `,
  { returns: 'oneOrNone' },
);
// user is { id: number; email: string } | undefined

await db.close();
```

The example assumes the table exists. Applications should reuse their database
instance and close it at shutdown. Tenon also provides SQL migration files and a
CLI to generate TypeScript row types from the database.

## Query result checking

A TypeScript annotation describes a query's result; it does not verify the SQL.
For development-time verification and annotation generation, configure the optional
SafeQL preset. This requires a development/test database at the intended schema
checkpoint and an application-owned ESLint configuration:

```sh
npm install --save-dev typescript@~6.0.2 @types/node@^24 @types/pg eslint@^10 typescript-eslint@^8 @ts-safeql/eslint-plugin@^5.4.2
```

```js
// eslint.config.mjs
import { tenonSafeql } from '@kequtech/tenon-orm/safeql';

export default tenonSafeql({
  databaseUrl: process.env.DATABASE_URL,
  tsconfigRootDir: import.meta.dirname,
});
```

Run `npx eslint "src/**/*.ts" --fix` to generate or repair annotations, then review
the changes. Run without `--fix` in CI to check without changing files. The preset
supports static fragment composition and reports runtime-built SQL it cannot check.
Runtime imports do not load SafeQL or ESLint. Custom pg parsers and array mappings
may need overrides; see the human guide for the full setup and limits.

## Documentation

- **[Human guide](docs/human-guide.md)** — setup, queries, composition, result typing,
  transactions, and schema changes with explanations.
- **[Agent guide](docs/agent-guide.md)** — concise API contracts, implementation
  conventions, and verification workflow.
- **[Adoption guide](docs/adoption-guide.md)** — move an existing application from another ORM.

The complete `docs/` folder ships with the npm package. Maintainer instructions are
in [CONTRIBUTING.md](https://github.com/kequtech/tenon-orm/blob/main/CONTRIBUTING.md),
which is not bundled.

[ISC licensed](LICENSE). Maintained by [Kequtech](https://github.com/kequtech).
