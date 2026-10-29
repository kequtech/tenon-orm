import { createPool, type Pool } from '@kequtech/pgclear';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const pool = createPool({ connectionString: testConnection });
try {
  console.log(`Test database: PostgreSQL ${await assertTestDatabase(pool)}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not check the test database.');
  process.exitCode = 1;
} finally {
  await pool.close();
}
