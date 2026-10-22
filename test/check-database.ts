import { Pool } from 'pg';

// Check before any integration test creates or changes a namespace. A passing
// suite must exercise the supported database baseline, not an older server.
const pool = new Pool({
  connectionString: process.env.TENON_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/tenom_orm_test',
});
try {
  const result = await pool.query<{ name: string; version: string; version_num: number }>(`
    SELECT current_database() AS name, current_setting('server_version') AS version,
      current_setting('server_version_num')::integer AS version_num
  `);
  const database = result.rows[0]!;
  if (database.name !== 'tenom_orm_test') {
    throw new Error('Tests require the tenom_orm_test database. No test schemas were changed.');
  }
  if (database.version_num < 160000) {
    throw new Error(`Tests require PostgreSQL 16 or newer; connected to ${database.version}. Upgrade the test server or set TENON_TEST_DATABASE_URL to a supported tenom_orm_test database. No test schemas were changed.`);
  }
  console.log(`Test database: PostgreSQL ${database.version}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not check the test database.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
