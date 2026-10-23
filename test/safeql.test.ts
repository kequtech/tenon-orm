import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import type { SqlQuery } from '../src/index.js';
import { generateDefinitions, migrate } from '../src/index.js';
import { tenonSafeql } from '../src/safeql.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const run = promisify(execFile);
test('the SafeQL preset requires an explicit database address', () => {
  assert.throws(() => tenonSafeql({ databaseUrl: '' }), /explicit development\/test databaseUrl/);
  // JavaScript callers must not accidentally select a default database either.
  // @ts-expect-error no connection was supplied
  assert.throws(() => tenonSafeql({}), /explicit development\/test databaseUrl/);
});

test('SafeQL checks actual Tenon tags, query functions and schema changes and reports contract errors', async () => {
  const pool = new Pool({ connectionString: testConnection });
  const directory = await mkdtemp(join(tmpdir(), 'tenon-safeql-'));
  try {
    await assertTestDatabase(pool);
    await migrationProject(pool)(
      {
        '0001_accounts.up.sql': `
        CREATE TYPE "Kind" AS ENUM ('person', 'company');
        CREATE TABLE "Account" (
          id integer PRIMARY KEY, email text NOT NULL, kind "Kind" NOT NULL,
          amount numeric NOT NULL, payload jsonb NOT NULL, created timestamptz NOT NULL,
          tags text[] NOT NULL
        );
        CREATE TABLE "Note" (account_id integer REFERENCES "Account", body text NOT NULL);
      `,
      },
      async (options) => {
        await migrate(options);
        await writeFile(join(directory, 'generated-schema.ts'), await generateDefinitions(options));
        const table = '"' + options.namespace + '"."Account"';
        const note = '"' + options.namespace + '"."Note"';
        await writeFile(join(directory, 'package.json'), '{"type":"module"}');
        await writeFile(
          join(directory, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              noEmit: true,
              module: 'NodeNext',
              target: 'ES2022',
              skipLibCheck: true,
            },
            include: ['*.ts'],
          }),
        );
        const config = `
        import { tenonSafeql } from ${JSON.stringify(pathToFileURL(resolve('dist/safeql.js')).href)};
        export default tenonSafeql({
          databaseUrl: process.env.TENON_TEST_DATABASE_URL,
          files: ['**/*.ts'],
          overrides: { columns: { 'Account.tags': 'PgArray<string>' } },
        });
      `;
        await writeFile(join(directory, 'eslint.config.mjs'), config);
        const imports = `import type { Account, PgArray } from './generated-schema.js';
type AccountSummary = Pick<Account, 'id' | 'email'>;
import { sql, type QueryClient } from ${JSON.stringify(resolve('dist/index.js'))};\n`;
        await writeFile(
          join(directory, 'valid.ts'),
          imports +
            `
        export const byEmail = (client: QueryClient, { email }: { email: string }) => client.query(
          sql<AccountSummary>\`SELECT id,email FROM ${table} WHERE email = \${email}\`,
          {returns:'oneOrNone'});
        export const joined = (client: QueryClient, { id }: { id: number }) => client.query(
          sql<{id:number;body:string|null}>\`SELECT a.id,n.body FROM ${table} a LEFT JOIN ${note} n ON n.account_id=a.id WHERE a.id=\${id}\`);
        export const summary = sql<{count:string;total:string|null}>\`SELECT count(*) AS count, sum(amount) AS total FROM ${table}\`;
        export const values = sql<{kind:'person'|'company';amount:string;payload:unknown;created:Date|number;tags:PgArray<string>}>\`SELECT kind,amount,payload,created,tags FROM ${table}\`;
        export const change = (client: QueryClient, { email, id }: { email: string; id: number }) => client.query(
          sql<{id:number}>\`UPDATE ${table} SET email=\${email} WHERE id=\${id} RETURNING id\`,
          {returns:'one',affectedRows:{exact:1}});
      `,
        );
        await writeFile(
          join(directory, 'invalid.ts'),
          imports +
            `
        const column = sql<{id:number}>\`SELECT missing FROM ${table}\`;
        const projection = sql<{id:string}>\`SELECT id FROM ${table}\`;
        const wrong = true;
        const parameter = sql<{id:number}>\`SELECT id FROM ${table} WHERE id = \${wrong}::boolean\`;
        const nullable = sql<{id:number;body:string}>\`SELECT a.id,n.body FROM ${table} a LEFT JOIN ${note} n ON n.account_id=a.id\`;
        const fragmentColumn = sql.fragment\`missing = \${1}\`;
        const badFragmentColumn = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${fragmentColumn}\`;
        const badType = sql.fragment\`id = \${true}::boolean\`;
        const badFragmentType = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${badType}\`;
      `,
        );
        async function lint(file: string, fix = false) {
          try {
            const result = await run(
              process.execPath,
              [
                resolve('node_modules/eslint/bin/eslint.js'),
                file,
                '--format',
                'json',
                ...(fix ? ['--fix'] : []),
              ],
              {
                cwd: directory,
                env: { ...process.env, TENON_TEST_DATABASE_URL: testConnection },
              },
            );
            return JSON.parse(result.stdout) as {
              messages: { message: string; ruleId: string }[];
            }[];
          } catch (error) {
            const result = error as { stdout?: string; stderr?: string };
            if (!result.stdout?.startsWith('[')) throw new Error(result.stderr || String(error));
            return JSON.parse(result.stdout) as {
              messages: { message: string; ruleId: string }[];
            }[];
          }
        }
        assert.deepEqual((await lint('valid.ts'))[0]!.messages, []);
        const failures = (await lint('invalid.ts'))[0]!.messages;
        assert.equal(failures.length, 6, JSON.stringify(failures));
        assert.ok(failures.every((m) => m.ruleId === '@ts-safeql/check-sql'));
        assert.ok(failures.some((m) => /missing/.test(m.message)));
        assert.ok(failures.some((m) => /integer = boolean/.test(m.message)));
        await writeFile(
          join(directory, 'inferred.ts'),
          imports +
            `
          import type { Database } from ${JSON.stringify(resolve('dist/index.js'))};
          declare const db: Database;
          export async function inferred(email: string) {
            const user = await db.query(sql\`SELECT id, email FROM ${table} WHERE email = \${email}\`, { returns: 'oneOrNone' });
            const joined = await db.query(sql\`SELECT a.id, n.body FROM ${table} a LEFT JOIN ${note} n ON n.account_id = a.id\`, { returns: 'many' });
            const aggregate = await db.query(sql\`SELECT count(*) AS count, sum(amount) AS total FROM ${table}\`, { returns: 'one' });
            const changed = await db.query(sql\`UPDATE ${table} SET email = \${email} RETURNING id\`, { returns: 'many' });
            const values = await db.query(sql\`SELECT tags, payload, created, amount FROM ${table}\`, { returns: 'one' });
            const predicate = sql.fragment\`email = \${email}\`;
            const nested = sql.fragment\`(\${predicate})\`;
            const composed = await db.query(sql\`SELECT id FROM ${table} WHERE \${sql.join([nested, sql.fragment\`id > \${0}\`], 'AND')}\`, { returns: 'many' });
            const composedId: number = composed[0]!.id;
            const primitive = sql.fragment\`id = ANY(\${[1, 2]}::int[]) AND \${true}::boolean AND \${null}::text IS NULL AND \${1n}::bigint > 0\`;
            const primitiveRows = await db.query(sql\`SELECT id FROM ${table} WHERE \${primitive}\`, { returns: 'many' });
            const primitiveId: number = primitiveRows[0]!.id;
            const repaired = await db.query(sql<{id:string}>\`SELECT id FROM ${table}\`, { returns: 'one' });
            const id: number | undefined = user?.id;
            const body: string | null = joined[0]!.body;
            const count: string = aggregate.count;
            const total: string | null = aggregate.total;
            const changedId: number = changed[0]!.id;
            const tags: PgArray<string> = values.tags;
            const created: Date | number = values.created;
            const amount: string = values.amount;
            const repairedId: number = repaired.id;
            // @ts-expect-error JSON remains unknown, not a presumed object shape
            values.payload.anything;
            // @ts-expect-error outer joins remain nullable
            const requiredBody: string = joined[0]!.body;
            // @ts-expect-error absence remains part of the execution contract
            const requiredId: number = user.id;
          }
        `,
        );
        const before = await readFile(join(directory, 'inferred.ts'), 'utf8');
        assert.ok((await lint('inferred.ts'))[0]!.messages.length > 0);
        assert.equal(await readFile(join(directory, 'inferred.ts'), 'utf8'), before);
        assert.deepEqual((await lint('inferred.ts', true))[0]!.messages, []);
        assert.deepEqual((await lint('inferred.ts'))[0]!.messages, []);
        await writeFile(
          join(directory, 'tsconfig.inferred.json'),
          JSON.stringify({
            extends: './tsconfig.json',
            include: ['inferred.ts', 'generated-schema.ts'],
          }),
        );
        await run(
          process.execPath,
          [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.inferred.json'],
          { cwd: directory },
        );
        await writeFile(
          join(directory, 'unsupported.ts'),
          imports +
            `
          const fragments = [sql.fragment\`id = \${1}\`];
          fragments.push(sql.fragment\`missing = \${2}\`);
          const dynamic = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${sql.join(fragments, 'AND')}\`;
          let mutable = sql.fragment\`id = \${1}\`;
          const reassigned = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${mutable}\`;
          const conditional = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${Math.random() ? sql.fragment\`TRUE\` : sql.fragment\`FALSE\`}\`;
          const build = () => sql.fragment\`TRUE\`;
          const factory = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${build()}\`;
          import { identifier } from ${JSON.stringify(resolve('dist/index.js'))};
          declare const tableName: string;
          const dynamicName = sql<{id:number}>\`SELECT id FROM \${identifier(tableName)}\`;
          declare const separator: 'AND';
          const dynamicSeparator = sql\`SELECT id FROM ${table} WHERE \${sql.join([sql.fragment\`TRUE\`], separator)}\`;
          const invalidSeparator = sql\`SELECT id FROM ${table} WHERE \${sql.join([sql.fragment\`TRUE\`], 'UNION')}\`;
          const oldSeparator = sql\`SELECT id FROM ${table} WHERE \${sql.join([sql.fragment\`TRUE\`], sql.fragment\` AND \`)}\`;
        `,
        );
        const unsupported = (await lint('unsupported.ts'))[0]!.messages;
        assert.equal(unsupported.length, 8, JSON.stringify(unsupported));
        assert.ok(
          unsupported.every((m) =>
            m.message.includes('Tenon cannot statically check this composition'),
          ),
        );
        await writeFile(
          join(directory, 'fragment.ts'),
          `
          import { sql } from ${JSON.stringify(resolve('dist/index.js'))};
          export const byId = sql.fragment\`id = \${1}\`;
        `,
        );
        await writeFile(
          join(directory, 'aliased.ts'),
          `
          import { sql as query, identifier as name } from ${JSON.stringify(resolve('dist/index.js'))};
          import * as tenon from ${JSON.stringify(resolve('dist/index.js'))};
          import { byId } from './fragment.js';
          const predicate = query.fragment\`\${name('id')} = \${1}\`;
          const table = name(${JSON.stringify(options.namespace)}, 'Account');
          export const first = query\`SELECT id FROM \${table} WHERE \${predicate}\`;
          export const second = tenon.sql\`SELECT id FROM ${table} WHERE \${byId}\`;
        `,
        );
        assert.equal((await lint('aliased.ts'))[0]!.messages.length, 2);
        assert.deepEqual((await lint('aliased.ts', true))[0]!.messages, []);
        await writeFile(
          join(directory, 'local-aliases.ts'),
          imports +
            `
          import * as tenon from ${JSON.stringify(resolve('dist/index.js'))};
          const query = sql;
          const tags = { sql };
          const { sql: destructured } = tenon;
          let mutableTag: typeof sql = query;
          const a = query\`SELECT missing FROM ${table}\`;
          const b = tags.sql\`SELECT missing FROM ${table}\`;
          const c = destructured\`SELECT missing FROM ${table}\`;
          const d = mutableTag\`SELECT missing FROM ${table}\`;
          const predicate = query.fragment\`missing = \${1}\`;
          const e = query\`SELECT id FROM ${table} WHERE \${predicate}\`;
          // Similar syntax from another library must not be checked as Tenon SQL.
          const other = { sql: (parts: TemplateStringsArray) => parts.join('') };
          const ignored = other.sql\`SELECT missing FROM ${table}\`;
        `,
        );
        const aliasErrors = (await lint('local-aliases.ts'))[0]!.messages;
        assert.equal(aliasErrors.length, 5, JSON.stringify(aliasErrors));
        assert.ok(aliasErrors.every((error) => error.message.includes('missing')));

        await writeFile(
          join(directory, 'invalid-identifiers.ts'),
          imports +
            `
          import { identifier } from ${JSON.stringify(resolve('dist/index.js'))};
          const a = sql\`SELECT 1 FROM \${identifier('')}\`;
          const b = sql\`SELECT 1 FROM \${identifier('bad\\0name')}\`;
          const c = sql\`SELECT 1 FROM \${identifier('${'é'.repeat(32)}')}\`;
          const d = sql\`SELECT missing FROM ${table}\`;
        `,
        );
        const identifierErrors = (await lint('invalid-identifiers.ts'))[0]!.messages;
        assert.equal(identifierErrors.length, 4, JSON.stringify(identifierErrors));
        assert.equal(
          identifierErrors.filter((error) => error.message.includes('1–63 UTF-8 bytes')).length,
          3,
        );
        assert.ok(identifierErrors.some((error) => error.message.includes('missing')));

        // These escapes change the executed SQL, including whether a UNION is a comment.
        await writeFile(
          join(directory, 'escapes.ts'),
          imports +
            [
              "export const quote = sql`SELECT '1\\'::int AS v --' AS v`;",
              "export const newline = sql`SELECT 1 AS v -- note\\n UNION ALL SELECT 'x'::text AS v`;",
              "export const tail = sql`SELECT ${1}::int AS v -- note\\n UNION ALL SELECT 'x'::text AS v`;",
              'const unrelated = (parts: TemplateStringsArray) => parts[0];',
              'const ignored = unrelated`escaped\\ntext`;',
            ].join('\n'),
        );
        const escapeErrors = (await lint('escapes.ts', true))[0]!.messages;
        assert.equal(escapeErrors.length, 3, JSON.stringify(escapeErrors));
        assert.ok(escapeErrors.every((error) => error.message.includes('JavaScript escapes')));

        // Check inferred annotations against executed queries, not just expected lint output.
        await pool.query(
          `INSERT INTO ${table} VALUES (1, 'reader@example.test', 'person', 1, '{}', now(), '{}')`,
        );
        await writeFile(
          join(directory, 'runtime.ts'),
          imports +
            `
          import type { SqlQuery } from ${JSON.stringify(resolve('dist/index.js'))};
          const value = sql.fragment\`\${1.5}\`;
          const cast = sql.fragment\`\${1.5}::float8\`;
          function enumQueries(kind: 'person' | 'company') {
            const condition = sql.fragment\`kind = \${kind}\`;
            return {
              direct: sql\`SELECT id FROM ${table} WHERE kind = \${kind}\`,
              fragment: sql\`SELECT id FROM ${table} WHERE \${condition}\`,
            };
          }
          function nullable(v: number | null) {
            const value = sql.fragment\`\${v}::int\`;
            return sql\`SELECT \${value} AS v\`;
          }
          const object = sql.fragment\`\${{ answer: 42 }}::jsonb\`;
          const escaped = sql.fragment\`SELECT '1\\'::int AS v --' AS v\`;
          const separator = 'OR' as const;
          const choice = sql.join([sql.fragment\`id = \${1}\`, sql.fragment\`id = \${2}\`], separator);
          const predicate = sql.join([sql.fragment\`(\${choice})\`, sql.fragment\`kind = \${'person'}\`], 'AND');
          export const queries = {
            bareDirect: sql\`SELECT \${1.5} AS v\`,
            bareFragment: sql\`SELECT \${value} AS v\`,
            castDirect: sql\`SELECT \${1.5}::float8 AS v\`,
            castFragment: sql\`SELECT \${cast} AS v\`,
            nullable: nullable(null),
            json: sql\`SELECT \${object} AS v\`,
            escapedFragment: sql\`\${escaped}\`,
            boundString: sql\`SELECT \${"a'b\\nc"}::text AS v\`,
            literalNewline: sql\`SELECT 1 AS v -- note
              UNION ALL SELECT 2 AS v\`,
            joined: sql\`SELECT \${sql.join([sql.fragment\`id\`, sql.fragment\`email\`], ',')} FROM ${table} WHERE \${predicate}\`,
            ...enumQueries('person'),
          };
          const bare: SqlQuery<{v: string | null}> = queries.bareFragment;
          const bareDirect: typeof bare = queries.bareDirect;
          const casted: SqlQuery<{v: number | null}> = queries.castFragment;
          const castDirect: typeof casted = queries.castDirect;
          const nullableResult: typeof casted = queries.nullable;
          const enumResult: SqlQuery<{id: number}> = queries.fragment;
          const enumDirect: typeof enumResult = queries.direct;
          const escapedResult: SqlQuery<{v: number}> = queries.escapedFragment;
          const joinedResult: SqlQuery<{id: number; email: string}> = queries.joined;
          // Value conversion is a runtime concern; this valid SQL has an invalid input.
          export const badInput = sql\`SELECT id FROM ${table} WHERE id = \${true}\`;
        `,
        );
        assert.deepEqual((await lint('runtime.ts', true))[0]!.messages, []);
        await writeFile(
          join(directory, 'tsconfig.runtime.json'),
          JSON.stringify({
            extends: './tsconfig.json',
            compilerOptions: { noEmit: false, outDir: './compiled' },
            include: ['runtime.ts', 'escapes.ts', 'generated-schema.ts'],
          }),
        );
        await run(
          process.execPath,
          [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.runtime.json'],
          { cwd: directory },
        );
        const runtime = (await import(
          pathToFileURL(join(directory, 'compiled/runtime.js')).href
        )) as {
          queries: Record<string, SqlQuery>;
          badInput: SqlQuery;
        };
        const rows: Record<string, unknown> = {};
        for (const [name, query] of Object.entries(runtime.queries)) {
          rows[name] = (await pool.query(query.text, [...query.values])).rows;
        }
        assert.deepEqual(rows, {
          bareDirect: [{ v: '1.5' }],
          bareFragment: [{ v: '1.5' }],
          castDirect: [{ v: 1.5 }],
          castFragment: [{ v: 1.5 }],
          nullable: [{ v: null }],
          json: [{ v: { answer: 42 } }],
          escapedFragment: [{ v: 1 }],
          boundString: [{ v: "a'b\nc" }],
          literalNewline: [{ v: 1 }, { v: 2 }],
          joined: [{ id: 1, email: 'reader@example.test' }],
          direct: [{ id: 1 }],
          fragment: [{ id: 1 }],
        });
        await assert.rejects(pool.query(runtime.badInput.text, [...runtime.badInput.values]), {
          code: '22P02',
        });
        const escapes = (await import(
          pathToFileURL(join(directory, 'compiled/escapes.js')).href
        )) as Record<'quote' | 'newline' | 'tail', SqlQuery>;
        assert.equal(escapes.quote.text, "SELECT '1'::int AS v --' AS v");
        assert.deepEqual((await pool.query(escapes.quote.text)).rows, [{ v: 1 }]);
        for (const query of [escapes.newline, escapes.tail]) {
          await assert.rejects(pool.query(query.text, [...query.values]), { code: '42804' });
        }
        await pool.query(`ALTER TABLE ${table} RENAME COLUMN email TO address`);
        assert.ok((await lint('valid.ts'))[0]!.messages.some((m) => /email/.test(m.message)));
      },
    );
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
