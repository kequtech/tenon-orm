import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
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

test('SafeQL checks actual Tenon tags, factories and schema changes and reports contract errors', async () => {
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
import { sql, defineOperation } from ${JSON.stringify(resolve('dist/index.js'))};\n`;
        await writeFile(
          join(directory, 'valid.ts'),
          imports +
            `
        export const byEmail = defineOperation((email: string) =>
          sql<AccountSummary>\`SELECT id,email FROM ${table} WHERE email = \${email}\`,
          {returns:'oneOrNone'});
        export const joined = defineOperation((id: number) =>
          sql<{id:number;body:string|null}>\`SELECT a.id,n.body FROM ${table} a LEFT JOIN ${note} n ON n.account_id=a.id WHERE a.id=\${id}\`);
        export const summary = sql<{count:string;total:string|null}>\`SELECT count(*) AS count, sum(amount) AS total FROM ${table}\`;
        export const values = sql<{kind:'person'|'company';amount:string;payload:unknown;created:Date|number;tags:PgArray<string>}>\`SELECT kind,amount,payload,created,tags FROM ${table}\`;
        export const change = defineOperation((email: string, id: number) =>
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
        const parameter = sql<{id:number}>\`SELECT id FROM ${table} WHERE id = \${wrong}\`;
        const nullable = sql<{id:number;body:string}>\`SELECT a.id,n.body FROM ${table} a LEFT JOIN ${note} n ON n.account_id=a.id\`;
        const fragmentColumn = sql.fragment\`missing = \${1}\`;
        const badFragmentColumn = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${fragmentColumn}\`;
        const badType = sql.fragment\`id = \${true}\`;
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
            const composed = await db.query(sql\`SELECT id FROM ${table} WHERE \${sql.join([nested, sql.fragment\`id > \${0}\`], sql.fragment\` AND \`)}\`, { returns: 'many' });
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
          const dynamic = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${sql.join(fragments, sql.fragment\` AND \`)}\`;
          let mutable = sql.fragment\`id = \${1}\`;
          const reassigned = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${mutable}\`;
          const conditional = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${Math.random() ? sql.fragment\`TRUE\` : sql.fragment\`FALSE\`}\`;
          const object = sql.fragment\`payload = \${{ arbitrary: 1 }}\`;
          const unknownMapping = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${object}\`;
          const build = () => sql.fragment\`TRUE\`;
          const factory = sql<{id:number}>\`SELECT id FROM ${table} WHERE \${build()}\`;
          import { identifier } from ${JSON.stringify(resolve('dist/index.js'))};
          declare const tableName: string;
          const dynamicName = sql<{id:number}>\`SELECT id FROM \${identifier(tableName)}\`;
        `,
        );
        const unsupported = (await lint('unsupported.ts'))[0]!.messages;
        assert.equal(unsupported.length, 6, JSON.stringify(unsupported));
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
        await pool.query(`ALTER TABLE ${table} RENAME COLUMN email TO address`);
        assert.ok((await lint('valid.ts'))[0]!.messages.some((m) => /email/.test(m.message)));
      },
    );
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
