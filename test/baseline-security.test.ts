import { fixtureTransaction } from './helpers/database.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createPool, type Pool } from '@kequtech/pgclear';
import { adoptBaseline, captureBaseline, migrate } from '../src/index.js';
import { qualified, quote } from '../src/sql.js';
import { assertTestDatabase, testConnection } from './helpers/database.js';

const admin = createPool({ connectionString: testConnection, maxConnections: 1 });
before(() => assertTestDatabase(admin));
after(() => admin.close());

async function securityState(namespace: string) {
  const [state] = (
    await admin.queryClassic(
      `
    SELECT n.nspowner::regrole::text AS schema_owner, c.relowner::regrole::text AS table_owner,
      p.proowner::regrole::text AS function_owner, p.prosecdef AS definer,
      p.proacl::text AS grants, p.proconfig::text AS settings,
      (SELECT count(*)::integer FROM pg_default_acl d WHERE d.defaclnamespace = n.oid) AS defaults
    FROM pg_namespace n JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'secret'
      JOIN pg_proc p ON p.pronamespace = n.oid AND p.proname = 'read_secret'
    WHERE n.nspname = $1`,
      [namespace],
    )
  ).rows;
  assert.ok(state);
  return state;
}

async function asRole(role: string, text: string) {
  return fixtureTransaction(admin, async (client) => {
    await client.script(`SET LOCAL ROLE ${quote(role)}`);
    return (await client.script(text)).at(-1)!;
  });
}

test('portable baseline replays without source roles; application SQL and provisioning establish target security', async () => {
  const id = randomUUID().replaceAll('-', '');
  const namespace = `tenon_security_${id}`;
  const sourceOwner = `tenon_source_owner_${id}`;
  const sourceRuntime = `tenon_source_runtime_${id}`;
  const owner = `tenon_target_owner_${id}`;
  const runtime = `tenon_target_runtime_${id}`;
  const denied = `tenon_denied_${id}`;
  const roles = [sourceOwner, sourceRuntime, owner, runtime, denied];
  const directory = await mkdtemp(join(tmpdir(), 'tenon-baseline-security-'));
  const options = { connection: testConnection, namespace, directory, schemas: [namespace] };
  const table = qualified(namespace, 'secret');
  const fn = qualified(namespace, 'read_secret');
  const query = `SELECT * FROM ${fn}()`;
  try {
    for (const role of [sourceOwner, sourceRuntime])
      await admin.queryClassic(`CREATE ROLE ${quote(role)} NOLOGIN`, []);
    await admin.withSession((session) =>
      session.script(`
      CREATE SCHEMA ${quote(namespace)} AUTHORIZATION ${quote(sourceOwner)};
      CREATE TABLE ${table} (value text NOT NULL);
      ALTER TABLE ${table} OWNER TO ${quote(sourceOwner)};
      INSERT INTO ${table} VALUES ('private');
      CREATE FUNCTION ${fn}() RETURNS TABLE (reader name, value text)
        LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
        AS $body$ SELECT current_user, s.value FROM ${table} s $body$;
      ALTER FUNCTION ${fn}() OWNER TO ${quote(sourceOwner)};
      REVOKE ALL ON FUNCTION ${fn}() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ${fn}() TO ${quote(sourceRuntime)};
      GRANT USAGE ON SCHEMA ${quote(namespace)} TO ${quote(sourceRuntime)};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(sourceOwner)} IN SCHEMA ${quote(namespace)}
        GRANT SELECT ON TABLES TO ${quote(sourceRuntime)};
    `),
    );
    const original = await securityState(namespace);
    assert.equal(original.function_owner, sourceOwner);
    assert.equal(original.defaults, 1);
    assert.deepEqual(
      [...(await asRole(sourceRuntime, query)).rows],
      [{ reader: sourceOwner, value: 'private' }],
    );
    await captureBaseline(options);
    await adoptBaseline(options);
    assert.deepEqual(await securityState(namespace), original);

    await admin.queryClassic(`DROP SCHEMA ${quote(namespace)} CASCADE`, []);
    for (const role of [sourceRuntime, sourceOwner])
      await admin.queryClassic(`DROP ROLE ${quote(role)}`, []);
    assert.deepEqual(await migrate(options), ['0001']);
    const [login] = (await admin.queryClassic<{ name: string }>('SELECT current_user AS name', []))
      .rows;
    assert.ok(login);
    const migrationRole = login.name;
    const replayed = await securityState(namespace);
    assert.equal(replayed.schema_owner, migrationRole);
    assert.equal(replayed.table_owner, migrationRole);
    assert.equal(replayed.function_owner, migrationRole);
    assert.equal(replayed.definer, true);
    assert.equal(replayed.settings, original.settings);
    assert.equal(replayed.defaults, 0);
    assert.equal(replayed.grants, null);

    for (const role of [owner, runtime, denied])
      await admin.queryClassic(`CREATE ROLE ${quote(role)} NOLOGIN`, []);
    async function canExecute(role: string) {
      return (
        await admin.queryClassic('SELECT has_function_privilege($1, $2, $3) AS allowed', [
          role,
          `${fn}()`,
          'EXECUTE',
        ])
      ).rows[0]!.allowed;
    }
    assert.equal(
      await canExecute(denied),
      true,
      'a portable dump does not retain the PUBLIC revocation',
    );

    // Fixed application policy references schema objects, not deployment role names.
    await writeFile(
      join(directory, '0002_function_policy.up.sql'),
      `REVOKE ALL ON FUNCTION ${fn}() FROM PUBLIC;`,
    );
    assert.deepEqual(await migrate(options), ['0002']);
    assert.equal(await canExecute(denied), false);

    // Deployment provisioning chooses different owners and runtime roles from the source.
    async function provision() {
      await fixtureTransaction(admin, async (client) => {
        await client.script(`
        ALTER SCHEMA ${quote(namespace)} OWNER TO ${quote(owner)};
        ALTER TABLE ${table} OWNER TO ${quote(owner)};
        ALTER FUNCTION ${fn}() OWNER TO ${quote(owner)};
        GRANT EXECUTE ON FUNCTION ${fn}() TO ${quote(runtime)};
        GRANT USAGE ON SCHEMA ${quote(namespace)} TO ${quote(runtime)}, ${quote(denied)};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(owner)} IN SCHEMA ${quote(namespace)}
          GRANT SELECT ON TABLES TO ${quote(runtime)};
        `);
      });
    }
    await provision();
    const provisioned = await securityState(namespace);
    await provision();
    assert.deepEqual(await securityState(namespace), provisioned);
    await admin.queryClassic(`INSERT INTO ${table} VALUES ('replayed')`, []);
    assert.deepEqual(
      [...(await asRole(runtime, query)).rows],
      [{ reader: owner, value: 'replayed' }],
    );
    await assert.rejects(asRole(denied, query), { code: '42501' });
    await assert.rejects(asRole(runtime, `SELECT * FROM ${table}`), { code: '42501' });
    const deployed = await securityState(namespace);
    assert.equal(deployed.schema_owner, owner);
    assert.equal(deployed.table_owner, owner);
    assert.equal(deployed.function_owner, owner);
    assert.equal(deployed.defaults, 1);

    const future = qualified(namespace, 'future');
    await asRole(
      owner,
      `CREATE TABLE ${future} (value text); INSERT INTO ${future} VALUES ('new table')`,
    );
    assert.deepEqual(
      [...(await asRole(runtime, `SELECT * FROM ${future}`)).rows],
      [{ value: 'new table' }],
    );
    await assert.rejects(asRole(denied, `SELECT * FROM ${future}`), { code: '42501' });
  } finally {
    try {
      await admin.queryClassic(`DROP SCHEMA IF EXISTS ${quote(namespace)} CASCADE`, []);
      for (const role of roles.reverse())
        await admin.queryClassic(`DROP ROLE IF EXISTS ${quote(role)}`, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
