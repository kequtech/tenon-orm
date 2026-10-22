import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { migrate } from '../src/index.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

const run = promisify(execFile);
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
        import safeql from ${JSON.stringify(pathToFileURL(resolve('node_modules/@ts-safeql/eslint-plugin/dist/config.mjs')).href)};
        import tseslint from ${JSON.stringify(pathToFileURL(resolve('node_modules/typescript-eslint/dist/index.js')).href)};
        export default [
          tseslint.configs.base,
          {files:['**/*.ts'], languageOptions:{parserOptions:{project:'./tsconfig.json'}}},
          safeql.configs.connections({
            databaseUrl: process.env.TENON_TEST_DATABASE_URL,
            keepAlive: false,
            inferLiterals: false,
            targets: [{tag:'sql'}],
            overrides: { types: { int8: 'string', numeric: 'string', jsonb: 'unknown', timestamptz: 'Date | number' },
              columns: { ${JSON.stringify('Account.tags')}: 'PgArray<string>' } },
          }),
        ];
      `;
        await writeFile(join(directory, 'eslint.config.mjs'), config);
        const imports = `type PgArray<T> = (T | null | PgArray<T>)[];
import { sql, defineOperation } from ${JSON.stringify(resolve('dist/index.js'))};\n`;
        await writeFile(
          join(directory, 'valid.ts'),
          imports +
            `
        export const byEmail = defineOperation((email: string) =>
          sql<{id:number;email:string}>\`SELECT id,email FROM ${table} WHERE email = \${email}\`,
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
      `,
        );
        async function lint(file: string) {
          try {
            const result = await run(
              process.execPath,
              [resolve('node_modules/eslint/bin/eslint.js'), file, '--format', 'json'],
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
        assert.equal(failures.length, 4, JSON.stringify(failures));
        assert.ok(failures.every((m) => m.ruleId === '@ts-safeql/check-sql'));
        assert.ok(failures.some((m) => /missing/.test(m.message)));
        assert.ok(failures.some((m) => /integer = boolean/.test(m.message)));
        await pool.query(`ALTER TABLE ${table} RENAME COLUMN email TO address`);
        assert.ok((await lint('valid.ts'))[0]!.messages.some((m) => /email/.test(m.message)));
      },
    );
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
