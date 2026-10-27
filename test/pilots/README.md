# Mail and Identity pilots

These pilots execute application source, rather than a hand-translated version of its SQL:

- Mail: `apps/mail/src/lib/client-data/address-message.ts`, `getClientAddressMessageRows`.
- Identity: `apps/identity/src/db/postgres-store.ts`,
  `PostgresIdentityStore.completeLinkEmailChallenge`.

Run from the Tenon repository with a normal monorepo dependency installation:

```sh
npm run test:pilots -- --applications /path/to/monorepo
```

`TENON_TEST_DATABASE_URL` has the same default as Tenon's integration tests. The command refuses
any database other than `tenon_orm_test`. It creates uniquely named schemas and NOLOGIN roles,
loads synthetic fixtures, and removes those resources in `finally`. The test connection needs
permission to create the temporary roles and schemas; the established local postgres test role
has these permissions. The application paths are used only to import code and read source hashes.

The app dependency installation was incomplete in the pilot environment. To avoid changing it,
Kysely 0.29.6, the version declared by both apps, was installed separately:

```sh
npm install --prefix /tmp/tenon-describe-pilot-deps --ignore-scripts --no-audit --no-fund kysely@0.29.6
npm run test:pilots -- --applications /path/to/monorepo --dependencies /tmp/tenon-describe-pilot-deps
```

## What is substituted

The Mail module's database import is injected with a Kysely connection backed by Postgres.js
through a small dialect bridge confined to the pilot.
Rendering and recipient dependencies throw if called; this pilot covers only the database query.
Mail's existing custom INT8-to-Number parser is retained on the execution connection.

Identity's explicit `identity` qualifiers are redirected to a unique fixture schema through a
Kysely operation-node plugin. Its transaction implementation and SQL remain the application's own.
Both execution connections use restricted effective roles and matching search path/timezone
settings. The fixture DDL is a relevant schema subset, not the applications' full migration history.

Kysely's query log captures the statements actually executed by each function. The pilot submits
each distinct SQL statement to Describe with the same effective role, search path and timezone.
Transaction-control statements are excluded: a separate session cannot describe a transaction's
state. Inspection context and result mappings are asserted explicitly. The script does not convert
either application to Tenon or exercise their HTTP/authentication/email-provider layers.

## Results on 27 October 2026

PostgreSQL 16.15, Kysely 0.29.6:

| Pilot               | Assertions                                                                                                                                                                                        | Description coverage                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Mail                | 22 input variants; complete row projections, unread/important/trash, escaped search, empty results, ids, limits, tied timestamp cursors, missing sender, deleted mailbox and cross-user isolation | 11 distinct SQL statements; exact 17-column names/read mappings; matching effective session settings                     |
| Identity email link | Success, replay rejection, expired/exhausted challenges, forced unique-constraint failure rolling back challenge consumption and email insertion, concurrent consumption with one winner          | 5 distinct SQL statements, including the guarded UPDATE RETURNING and advisory lock; matching effective session settings |

The script reports source SHA-256 values for reproducibility. The run above used:

```text
Mail:     27c0c98ea4fd92f6b69c17bae6ccbcbc6f8bf6e65cc6ebca0385273380c386e1
Identity: 698af4277e638ab82d000d122c8f404cde78eff28071ccbfb9abcc17d4e52c42
```

All assertions passed. The piloted Mail projection contains no bigint fields, but an additional
probe confirms its custom runtime parser returns a number where the inspector's Postgres.js mapping
reports a string. Session configuration parity does not establish parser parity. This discrepancy
is surfaced as a pilot finding, not silently resolved by an inspector override.

## API decision

The small explicit session interface fits both piloted paths. Completed SQL from existing builders
works without a compiler API, SQL reconstruction, or rewriting application queries. The Identity
pilot also demonstrates why database transaction assertions remain necessary: Describe succeeds
for the same statements whose execution can violate constraints or lose a consumption race.

The public API is `describeQuery` from `@kequtech/tenon-orm`; the CLI is `tenon describe query.sql`.
The supported boundary is a separate inspection session with
explicit context and Postgres.js mappings. Exact inspection inside an existing application transaction,
custom parser inference, automatic TypeScript annotation checking, full application migrations,
and all combinations of application inputs have not been established by these pilots.
