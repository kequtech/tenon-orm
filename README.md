# Tenon ORM

A PostgreSQL ORM for coding agents and the humans reviewing their work.

Tenon provides parameterized SQL, reusable typed operations, SQL migrations, and
TypeScript row types generated from your database. Queries stay ordinary SQL;
your application owns the `pg` driver and connection configuration.

```sh
npm install @kequtech/tenon-orm pg
```

Requires Node.js 24+, PostgreSQL 16+, and ESM. TypeScript consumers need TypeScript 6+.

- **[Agent guide](agent-guide.md)** — installation, queries, transactions,
  migrations, generated types, and optional SQL checking. Start here when using Tenon.
- **[Adoption guide](adoption-guide.md)** — move an existing application from another ORM.

Both guides ship with the npm package. Maintainer instructions are in
[contributing](https://github.com/kequtech/tenon-orm/blob/main/docs/contributing.md).

[ISC licensed](LICENSE). Maintained by [Kequtech](https://github.com/kequtech).
