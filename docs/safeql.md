# SQL checking with SafeQL

SafeQL can check Tenon's tagged SQL against a development database and compare
result annotations with the query. It is optional development tooling; Tenon
does not load it at runtime.

The verified setup uses SafeQL 5.4, ESLint 10, typescript-eslint 8, and TypeScript 6. Tenon also supports TypeScript 7 consumers, but typescript-eslint currently
requires the TypeScript 6 compiler API. Use a compatible linting toolchain rather
than bypassing peer-dependency checks.

```sh
npm install --save-dev typescript@~6.0.2 eslint typescript-eslint @ts-safeql/eslint-plugin
```

Add to `eslint.config.mjs`, using your development database configuration:

```js
import safeql from '@ts-safeql/eslint-plugin/config';
import tseslint from 'typescript-eslint';

export default [
  tseslint.configs.base,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.json' },
    },
  },
  {
    ...safeql.configs.connections({
      databaseUrl: process.env.DATABASE_URL,
      targets: [{ tag: 'sql' }],
      inferLiterals: false,
      overrides: {
        types: {
          int8: 'string',
          numeric: 'string',
          json: 'unknown',
          jsonb: 'unknown',
          date: 'Date | number',
          timestamp: 'Date | number',
          timestamptz: 'Date | number',
        },
      },
    }),
    files: ['src/**/*.ts'],
  },
];
```

```sh
npx eslint "src/**/*.ts"
```

Combine this with the application's existing TypeScript lint rules. Keep their
file scopes explicit. The `sql` import name must match the configured target;
update it if you alias the tag.

SafeQL sees the tag inside a factory without needing special configuration for
`defineOperation`:

```ts
export const userByEmail = defineOperation(
  (email: string) => sql<{ id: number; email: string }>`
    SELECT id, email FROM public."User" WHERE email = ${email}
  `,
  { returns: 'oneOrNone' },
);
```

Migrate the development/checking database before linting. CI should replay
migrations into its test database and run ESLint alongside TypeScript and
integration tests. Linting does not run as part of ordinary `tsc`.

## Mapping and analysis limits

Use the application's actual pg parsing policy. The overrides above preserve
numeric strings, unknown JSON, and date/timestamp infinities. Custom driver
parsers need different overrides.

PostgreSQL arrays may contain null elements and multiple dimensions. SafeQL's
default `string[]` inference does not describe that full contract. For a column
whose generated type is `PgArray<string>`, add a column override and use that
imported type in the query projection:

```js
overrides: {
  // Keep the scalar overrides above too.
  columns: { 'User.tags': 'PgArray<string>' },
}
```

Numeric-array values use `PgArray<number>`, despite scalar numeric returning
strings. Column keys use `Table.column`, not a schema-qualified path; take care
when different schemas reuse a table name. JSON contracts likewise need deliberate
application validation rather than an optimistic inferred shape.

The integration test covers factories, joins and nullability, enums, aggregates,
numeric/date/JSON/array overrides, writes, and a renamed column. It also verifies
that wrong projections and parameter types produce diagnostics. Complex
expressions can still infer conservative nullability.

Prefer fixed SQL structure for checked queries. SafeQL cannot generally resolve
runtime identifiers or arbitrary fragments, and does not inspect `unsafeSql`.
It cannot establish authorization, intended row counts, trigger effects, or the
correctness of application logic.

For syntax checking migration files, consider
[eslint-plugin-postgresql](https://github.com/baseballyama/eslint-plugin-postgresql).
Choose its rules to fit transactional migrations. See the
[SafeQL API](https://safeql.dev/api/) for additional configuration.
