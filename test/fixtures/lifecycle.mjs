import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import {
  createTenon,
  sql,
  identifier,
  AffectedRowsError,
  migrate,
  rollback,
  migrationStatus,
  generateDefinitions,
  captureBaseline,
  adoptBaseline,
} from '@kequtech/tenon-orm';
import * as second from './second-tenon/index.js';

// Runs after installing the tarball in an isolated consumer directory.
const connection = process.env.TENON_TEST_DATABASE_URL;
const pool = postgres(connection);
const namespace = 'tenon_product_' + randomUUID().replaceAll('-', '');
const history = namespace + '_history';
const directory = await mkdtemp(join(tmpdir(), 'tenon-product-'));
const options = { connection: pool, namespace, directory };
const table = identifier(namespace, 'Account');
const db = createTenon({ connection: pool });
let ownsNamespace = false;
try {
  const database = await pool.unsafe('SELECT current_database() AS name');
  assert.equal(database[0].name, 'tenon_orm_test');
  await writeFile(
    join(directory, '0001_accounts.up.sql'),
    'CREATE TABLE "Account" (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text UNIQUE NOT NULL);',
  );
  await writeFile(join(directory, '0001_accounts.down.sql'), 'DROP TABLE "Account";');
  ownsNamespace = true;
  assert.deepEqual(await migrate(options), ['0001']);
  const firstTypes = await generateDefinitions(options);
  const createAccount = (client, { email }) =>
    client.query(
      sql`
    INSERT INTO ${table} (email) VALUES (${email}) RETURNING id, email`,
      { returns: 'one', affectedRows: { exact: 1 } },
    );
  const oldRead = (client, { id }) =>
    client.query(sql`SELECT id,email FROM ${table} WHERE id=${id}`, {
      returns: 'one',
    });
  const account = await createAccount(db, { email: 'first@example.test' });
  const copiedLookup = (client, { id }) =>
    client.query(
      second.sql`SELECT id,email FROM ${identifier(namespace, 'Account')} WHERE id=${id}`,
      { returns: 'one' },
    );
  assert.deepEqual(await copiedLookup(db, { id: account.id }), account);
  assert.deepEqual(
    await db.query(
      sql`SELECT id,email FROM ${second.identifier(namespace, 'Account')} WHERE id=${account.id}`,
      { returns: 'one' },
    ),
    account,
  );
  assert.throws(() => sql`SELECT ${second.sql`SELECT 1`}`, /Nested SQL/);

  await writeFile(
    join(directory, '0002_active.up.sql'),
    'ALTER TABLE "Account" ADD COLUMN active boolean NOT NULL DEFAULT true;',
  );
  await writeFile(
    join(directory, '0002_active.down.sql'),
    'ALTER TABLE "Account" DROP COLUMN active;',
  );
  assert.deepEqual(await migrate(options), ['0002']);
  assert.notEqual(await generateDefinitions(options), firstTypes);
  // Old and new application projections coexist after an additive migration.
  assert.deepEqual(await oldRead(db, { id: account.id }), account);
  const newRead = (client, { id }) =>
    client.query(sql`SELECT id,email,active FROM ${table} WHERE id=${id}`, { returns: 'one' });
  assert.equal((await newRead(db, { id: account.id })).active, true);
  await createAccount(db, { email: 'second@example.test' });
  await assert.rejects(
    db.query(sql`UPDATE ${table} SET active=false`, {
      affectedRows: { exact: 1 },
    }),
    (error) => error instanceof AffectedRowsError && error.actual === 2,
  );
  assert.equal((await newRead(db, { id: account.id })).active, true);

  await writeFile(
    join(directory, '0003_failed.up.sql'),
    'ALTER TABLE "Account" ADD COLUMN incomplete integer; SELECT nonexistent_column;',
  );
  await assert.rejects(migrate(options), /0003_failed/);
  assert.deepEqual((await migrationStatus(options)).pending, ['0003']);
  assert.equal((await generateDefinitions(options)).includes('"incomplete"'), false);
  // This migration never committed; repairing it leaves applied history intact.
  await writeFile(
    join(directory, '0003_failed.up.sql'),
    'ALTER TABLE "Account" ADD COLUMN note text;',
  );
  await writeFile(
    join(directory, '0003_failed.down.sql'),
    'ALTER TABLE "Account" DROP COLUMN note;',
  );
  await migrate(options);
  await rollback(options);
  assert.deepEqual(await oldRead(db, { id: account.id }), account);

  const baselineDirectory = join(directory, 'baseline');
  await captureBaseline({
    connection,
    namespace: history,
    directory: baselineDirectory,
    schemas: [namespace],
  });
  await pool.unsafe('CREATE SCHEMA "' + history + '"');
  assert.deepEqual(
    await adoptBaseline({ connection: pool, namespace: history, directory: baselineDirectory }),
    ['0001'],
  );
  assert.deepEqual(await oldRead(db, { id: account.id }), account);
  await pool.unsafe('DROP SCHEMA "' + history + '" CASCADE');

  // Schema replay plus a logical row snapshot; not a physical backup/PITR test.
  const snapshot = await db.query(sql`SELECT id,email,active FROM ${table} ORDER BY id`, {
    returns: 'many',
  });
  await pool.unsafe('DROP SCHEMA "' + namespace + '" CASCADE');
  await migrate({ connection: pool, namespace: history, directory: baselineDirectory });
  await db.transaction(async (tx) => {
    for (const row of snapshot) {
      await tx.query(
        sql`INSERT INTO ${table} (id,email,active) OVERRIDING SYSTEM VALUE
        VALUES (${row.id},${row.email},${row.active})`,
        { affectedRows: { exact: 1 } },
      );
    }
    // Explicit IDs require restoring the identity sequence position as well.
    await tx.query(sql`SELECT setval(pg_get_serial_sequence(${'"' + namespace + '"."Account"'}, 'id'),
      (SELECT max(id) FROM ${table}))`);
  });
  assert.deepEqual(
    await db.query(sql`SELECT id,email,active FROM ${table} ORDER BY id`, { returns: 'many' }),
    snapshot,
  );
  assert.ok(
    (await createAccount(db, { email: 'after-restore@example.test' })).id > snapshot.at(-1).id,
  );
  console.log('Installed lifecycle passed.');
} finally {
  try {
    if (ownsNamespace) {
      await pool.unsafe('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
      await pool.unsafe('DROP SCHEMA IF EXISTS "' + history + '" CASCADE');
    }
  } finally {
    await db.close();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
}
