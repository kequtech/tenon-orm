import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createTenon, identifier, migrate, sql } from '../src/index.js';
import { assertTestDatabase, migrationProject, testConnection } from './helpers/database.js';

test('dynamic predicates and ordering execute with bound values and guarded transactions', async () => {
  const pool = new Pool({ connectionString: testConnection });
  const db = createTenon({ connection: pool });
  try {
    await assertTestDatabase(pool);
    await migrationProject(pool)(
      {
        '0001_users.up.sql': `CREATE TABLE users (id int PRIMARY KEY, tenant int NOT NULL, email text NOT NULL);
        INSERT INTO users VALUES (1, 1, 'one'), (2, 1, 'two'), (3, 2, 'one');`,
      },
      async (options) => {
        await migrate(options);
        const table = identifier(options.namespace, 'users');
        async function search(email?: string, descending = false) {
          const filters = [sql.fragment`tenant = ${1}`];
          if (email !== undefined) filters.push(sql.fragment`email = ${email}`);
          const direction = descending ? sql.fragment`DESC` : sql.fragment`ASC`;
          return db.query(
            sql<{ id: number }>`SELECT id FROM ${table}
          WHERE ${sql.join(filters, sql.fragment` AND `)} ORDER BY id ${direction}`,
            { returns: 'many' },
          );
        }
        assert.deepEqual(await search(), [{ id: 1 }, { id: 2 }]);
        assert.deepEqual(await search(undefined, true), [{ id: 2 }, { id: 1 }]);
        assert.deepEqual(await search('one'), [{ id: 1 }]);
        assert.deepEqual(await search("one' OR TRUE --"), []);
        await db.transaction(async (tx) => {
          const scope = sql.fragment`tenant = ${1}`;
          await assert.rejects(
            tx.query(sql`UPDATE ${table} SET email = ${'changed'} WHERE ${scope}`, {
              affectedRows: { exact: 1 },
            }),
          );
          await tx.query(
            sql`UPDATE ${table} SET email = ${'updated'} WHERE ${scope} AND id = ${1}`,
            {
              affectedRows: { exact: 1 },
            },
          );
        });
        assert.deepEqual(await search('updated'), [{ id: 1 }]);
        assert.deepEqual(await search('two'), [{ id: 2 }]);
      },
    );
  } finally {
    await db.close();
    await pool.end();
  }
});
