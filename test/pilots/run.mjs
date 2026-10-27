import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { executeSql } from '../../dist/connection.js';
import { prepareArrays } from '../../dist/driver/array.js';
import { reserveConnection } from '../../dist/driver/session.js';
import { describeQuery } from '../../dist/index.js';
import { quote, qualified } from '../../dist/sql.js';
import { setMailContext } from './mail-context.mjs';

const { values } = parseArgs({
  options: {
    applications: { type: 'string' },
    dependencies: { type: 'string' },
  },
});
if (!values.applications) throw new Error('Pass --applications /path/to/monorepo.');
const applications = resolve(values.applications);
const appRequire = createRequire(
  join(
    values.dependencies ? resolve(values.dependencies) : join(applications, 'apps/identity'),
    'package.json',
  ),
);
const kyselyURL = pathToFileURL(appRequire.resolve('kysely')).href;
const { Kysely, PostgresDialect, OperationNodeTransformer, sql } = await import(kyselyURL);
const kyselyVersion = JSON.parse(
  await readFile(fileURLToPath(new URL('../package.json', kyselyURL)), 'utf8'),
).version;
assert.equal(kyselyVersion, '0.29.6', "Pilot must use the applications' Kysely version.");

const mailSource = join(applications, 'apps/mail/src/lib/client-data/address-message.ts');
const identitySource = join(applications, 'apps/identity/src/db/postgres-store.ts');
const mailURL = pathToFileURL(mailSource).href;
const contextURL = new URL('./mail-context.mjs', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === 'kysely' &&
      context.parentURL?.startsWith(pathToFileURL(applications + '/').href)
    ) {
      return { url: kyselyURL, shortCircuit: true };
    }
    if (
      context.parentURL === mailURL &&
      ['@/db/mail', '@/lib/email-html', './recipient'].includes(specifier)
    ) {
      return { url: contextURL, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
let getRows, PostgresIdentityStore;
try {
  ({ getClientAddressMessageRows: getRows } = await import(mailURL));
  ({ PostgresIdentityStore } = await import(pathToFileURL(identitySource).href));
} finally {
  hooks.deregister();
}

const connection =
  process.env.TENON_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/tenon_orm_test';
const admin = postgres(connection, { max: 2 });
const createdSchemas = [],
  createdRoles = [],
  databases = [];
const id = randomUUID().replaceAll('-', '');

async function setup(label) {
  const schema = `tenon_${label}_pilot_${id}`;
  const role = `tenon_${label}_role_${id}`;
  await admin.unsafe(`CREATE SCHEMA ${quote(schema)}`);
  createdSchemas.push(schema);
  await admin.unsafe(`CREATE ROLE ${quote(role)} NOLOGIN`);
  createdRoles.push(role);
  const client = await admin.reserve();
  try {
    await client.unsafe('BEGIN');
    await client.unsafe("SELECT set_config('search_path',$1,true)", [quote(schema)]);
    await client.unsafe(await readFile(new URL(`./${label}.sql`, import.meta.url), 'utf8'));
    await client.unsafe('COMMIT');
  } catch (error) {
    await client.unsafe('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await admin.unsafe(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)};
    GRANT ${label === 'mail' ? 'SELECT' : 'SELECT,INSERT,UPDATE'} ON ALL TABLES IN SCHEMA ${quote(schema)} TO ${quote(role)}`);
  const session = {
    role,
    searchPath: `${schema}${label === 'mail' ? ',public' : ''}`,
    timeZone: 'UTC',
  };
  const native = postgres(connection, {
    max: 4,
    connection: { role, search_path: session.searchPath, TimeZone: 'UTC' },
    ...(label === 'mail'
      ? { types: { bigint: { to: 20, from: [20], parse: Number, serialize: String } } }
      : {}),
  });
  // Kysely's dialect expects its own pool/client protocol. Keep that bridge in the
  // pilot; every query and transaction still executes through Postgres.js.
  async function query(client, text, values) {
    try {
      const rows = await executeSql(client, text, values);
      return { rows: [...rows], rowCount: rows.count, command: rows.command };
    } catch (error) {
      // Kysely's pg dialect appends to error.stack, which Postgres.js makes read-only.
      // Adapt only this fixture boundary; Tenon returns the native driver error unchanged.
      if (error instanceof Error)
        throw Object.assign(new Error(error.message, { cause: error }), error);
      throw error;
    }
  }
  const pool = {
    async query(text, values = []) {
      await prepareArrays(native);
      return query(native, text, values);
    },
    async connect() {
      const lease = await reserveConnection(native);
      return {
        async query(text, values = []) {
          lease.check();
          return query(lease.sql, text, values);
        },
        release() {
          void lease.release();
        },
      };
    },
    end: () => native.end(),
  };
  class FixtureSchema extends OperationNodeTransformer {
    transformSchemableIdentifier(node, queryId) {
      const transformed = super.transformSchemableIdentifier(node, queryId);
      return transformed.schema?.name === 'identity'
        ? { ...transformed, schema: { ...transformed.schema, name: schema } }
        : transformed;
    }
  }
  const transformer = new FixtureSchema();
  const queries = [];
  const db = new Kysely({
    dialect: new PostgresDialect({ pool }),
    plugins:
      label === 'identity'
        ? [
            {
              transformQuery: ({ node, queryId }) => transformer.transformNode(node, queryId),
              async transformResult({ result }) {
                return result;
              },
            },
          ]
        : [],
    log(event) {
      queries.push(event.query);
    },
  });
  databases.push(db);
  assert.deepEqual(
    (
      await pool.query(`SELECT current_user AS role,current_setting('search_path') AS path,
    current_setting('TimeZone') AS zone`)
    ).rows,
    [{ role, path: session.searchPath, zone: 'UTC' }],
  );
  return { schema, role, session, db, queries, pool };
}

async function inspectQueries(pilot) {
  const unique = new Set(
    pilot.queries.map((q) => q.sql).filter((text) => !/^(begin|commit|rollback)\b/i.test(text)),
  );
  for (const query of unique) {
    const result = await describeQuery({ connection, session: pilot.session, query });
    assert.equal(result.context.currentUser, pilot.role);
    assert.equal(result.context.searchPath, pilot.session.searchPath);
    assert.equal(result.context.timeZone, 'UTC');
    assert.ok(!result.issues.some((issue) => issue.code === 'duplicate-column'));
  }
  return unique.size;
}

async function mailPilot() {
  const pilot = await setup('mail');
  setMailContext(pilot.db, sql);
  const owner = '20000000-0000-4000-8000-000000000001';
  const mailbox = '10000000-0000-4000-8000-000000000001';
  const message = (n) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const rowId = (n) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const cases = [
    [{}, [2, 1]],
    [{ filter: 'unread' }, [1]],
    [{ filter: 'important' }, [2]],
    [{ trash: true }, [3]],
    [{ search: 'Match' }, [2, 1]],
    [{ search: '100%_' }, [1]],
    [{ search: 'does-not-match' }, []],
    [{ search: 'sender@example.invalid' }, [1]],
    [{ search: 'Other' }, []],
    [{ search: "%' OR true --" }, []],
    [{ addressId: mailbox }, [2, 1]],
    [{ addressMessageId: rowId(1) }, [1]],
    [{ messageId: message(2) }, [2]],
    [{ limit: 1 }, [2]],
    [{ before: { createdAt: new Date('2026-10-01T12:00:00Z'), id: rowId(2) } }, [1]],
    [{ filter: 'unread', search: 'Match', addressId: mailbox, limit: 1 }, [1]],
    [{ trash: true, filter: 'important' }, []],
    [{ addressId: '10000000-0000-4000-8000-000000000002' }, []],
    [{ addressMessageId: rowId(4) }, []],
    [{ addressMessageId: rowId(5) }, []],
  ];
  function expectedRow(n) {
    const internal = n === 2;
    return {
      id: rowId(n),
      message_id: message(n),
      subject: n === 1 ? 'Match one' : internal ? 'Match two' : 'Trash',
      text: n === 1 ? 'body 100%_ literal' : internal ? 'body two' : 'body three',
      html: internal ? '<p>two</p>' : null,
      created_at: new Date(n === 3 ? '2026-09-30T12:00:00Z' : '2026-10-01T12:00:00Z'),
      is_important: internal,
      is_read: internal,
      address_name: internal ? 'Internal' : 'External',
      address_local: internal ? 'internal' : 'sender',
      address_domain: internal ? 'myaddress.cc' : 'example.invalid',
      address_id: mailbox,
      prefer_text: false,
      load_remote_images: false,
      sender_user_id: internal ? '20000000-0000-4000-8000-000000000002' : null,
      sender_address_id: internal ? '10000000-0000-4000-8000-000000000002' : null,
      sender_label: internal ? 'Other' : null,
    };
  }
  for (const [options, expected] of cases) {
    assert.deepEqual(await getRows(owner, options), expected.map(expectedRow));
  }
  assert.deepEqual(await getRows('20000000-0000-4000-8000-000000000099', {}), []);
  assert.deepEqual(
    (await getRows('20000000-0000-4000-8000-000000000002', {})).map((row) => row.id),
    [rowId(4)],
  );
  const describedStatements = await inspectQueries(pilot);
  const sender = await describeQuery({
    connection,
    session: pilot.session,
    query: { text: pilot.queries[0].sql },
  });
  assert.deepEqual(
    sender.columns.map((c) => [c.name, c.readType]),
    [
      ['id', 'string'],
      ['message_id', 'string'],
      ['subject', 'string'],
      ['text', 'string'],
      ['html', 'string'],
      ['created_at', 'globalThis.Date'],
      ['is_important', 'boolean'],
      ['is_read', 'boolean'],
      ['address_name', 'string'],
      ['address_local', 'string'],
      ['address_domain', 'string'],
      ['address_id', 'string'],
      ['prefer_text', 'boolean'],
      ['load_remote_images', 'boolean'],
      ['sender_user_id', 'string'],
      ['sender_address_id', 'string'],
      ['sender_label', 'string'],
    ],
  );
  const counter = await describeQuery({
    connection,
    session: pilot.session,
    query: 'SELECT 9007199254740993::bigint AS size',
  });
  assert.equal(counter.columns[0].readType, 'string');
  assert.equal(counter.context.readMappings, 'postgres');
  assert.equal(
    typeof (await pilot.pool.query('SELECT 9007199254740993::bigint AS size')).rows[0].size,
    'number',
  );
  assert.equal(sender.columns.find((c) => c.name === 'sender_user_id').source.notNull, true);
  assert.equal(sender.columns.find((c) => c.name === 'sender_user_id').nullability, 'unknown');
  return {
    variants: cases.length + 2,
    describedStatements,
    completeProjectionAssertions: 'passed',
    int8ExecutionMapping: 'custom-number-parser-differs-from-default-inspection',
    ownershipAndCursorAssertions: 'passed',
  };
}

async function identityPilot() {
  const pilot = await setup('identity');
  const store = new PostgresIdentityStore(pilot.db);
  const accountId = '60000000-0000-4000-8000-000000000001';
  const now = new Date('2026-10-01T12:00:00Z');
  const table = (name) => qualified(pilot.schema, name);
  async function challenge(label, overrides = {}) {
    const challengeId = randomUUID();
    const email = `${label}@example.invalid`;
    const input = {
      challengeId,
      now,
      accountId,
      privateEmail: {
        id: randomUUID(),
        accountId,
        normalizedEmail: email,
        canonicalEmail: email,
        createdAt: now,
      },
      method: {
        id: randomUUID(),
        accountId,
        provider: 'email',
        providerSubject: email,
        privateEmailId: null,
        createdAt: now,
      },
    };
    input.method.privateEmailId = input.privateEmail.id;
    await admin.unsafe(
      `INSERT INTO ${table('passwordless_challenge')}
      (id, normalized_email, canonical_email, account_id, purpose, code_hash,
       attempt_count, max_attempts, expires_at, consumed_at, created_at)
      VALUES($1,$2,$2,$3,'link_email','synthetic-pilot-hash',$4,3,$5,NULL,$6)`,
      [
        challengeId,
        email,
        accountId,
        overrides.attempts ?? 0,
        overrides.expires ?? new Date(now.getTime() + 60000),
        now,
      ],
    );
    return input;
  }
  const first = await challenge('first');
  assert.equal(await store.completeLinkEmailChallenge(first), 'linked');
  assert.equal(await store.completeLinkEmailChallenge(first), 'not_consumed');
  assert.deepEqual(
    [
      ...(await admin.unsafe(
        `SELECT consumed_at FROM ${table('passwordless_challenge')} WHERE id=$1`,
        [first.challengeId],
      )),
    ],
    [{ consumed_at: now }],
  );
  assert.deepEqual(
    [
      ...(await admin.unsafe(`SELECT * FROM ${table('private_email')} WHERE id=$1`, [
        first.privateEmail.id,
      ])),
    ],
    [
      {
        id: first.privateEmail.id,
        account_id: accountId,
        normalized_email: first.privateEmail.normalizedEmail,
        canonical_email: first.privateEmail.canonicalEmail,
        verified_at: now,
        created_at: now,
      },
    ],
  );
  assert.deepEqual(
    [
      ...(await admin.unsafe(`SELECT * FROM ${table('authentication_method')} WHERE id=$1`, [
        first.method.id,
      ])),
    ],
    [
      {
        id: first.method.id,
        account_id: accountId,
        provider: 'email',
        provider_subject: first.method.providerSubject,
        private_email_id: first.privateEmail.id,
        created_at: now,
        revoked_at: null,
      },
    ],
  );
  const failed = await challenge('rollback');
  failed.method.providerSubject = first.method.providerSubject;
  await assert.rejects(store.completeLinkEmailChallenge(failed), { code: '23505' });
  assert.equal(
    (
      await admin.unsafe(`SELECT consumed_at FROM ${table('passwordless_challenge')} WHERE id=$1`, [
        failed.challengeId,
      ])
    )[0].consumed_at,
    null,
  );
  assert.deepEqual(
    [
      ...(await admin.unsafe(`SELECT id FROM ${table('private_email')} WHERE id=$1`, [
        failed.privateEmail.id,
      ])),
    ],
    [],
  );
  const concurrent = await challenge('concurrent');
  assert.deepEqual(
    (
      await Promise.all([
        store.completeLinkEmailChallenge(concurrent),
        store.completeLinkEmailChallenge(concurrent),
      ])
    ).sort(),
    ['linked', 'not_consumed'],
  );
  for (const input of [
    await challenge('expired', { expires: now }),
    await challenge('exhausted', { attempts: 3 }),
  ]) {
    assert.equal(await store.completeLinkEmailChallenge(input), 'not_consumed');
    assert.equal(
      (
        await admin.unsafe(
          `SELECT consumed_at FROM ${table('passwordless_challenge')} WHERE id=$1`,
          [input.challengeId],
        )
      )[0].consumed_at,
      null,
    );
  }
  assert.equal(
    (await admin.unsafe(`SELECT count(*) FROM ${table('private_email')}`))[0].count,
    '2',
  );
  assert.equal(
    (await admin.unsafe(`SELECT count(*) FROM ${table('authentication_method')}`))[0].count,
    '2',
  );
  const describedStatements = await inspectQueries(pilot);
  return {
    operation: 'PostgresIdentityStore.completeLinkEmailChallenge',
    describedStatements,
    successReplayExpiryAttemptsRollbackConcurrency: 'passed',
  };
}

try {
  const [{ name, version }] = await admin.unsafe(`SELECT current_database() AS name,
    current_setting('server_version') AS version`);
  assert.equal(name, 'tenon_orm_test', 'Pilots require the dedicated Tenon test database.');
  const mail = await mailPilot();
  const identity = await identityPilot();
  console.log(
    JSON.stringify(
      {
        postgres: version,
        kysely: kyselyVersion,
        source: {
          mail: createHash('sha256')
            .update(await readFile(mailSource))
            .digest('hex'),
          identity: createHash('sha256')
            .update(await readFile(identitySource))
            .digest('hex'),
        },
        mail,
        identity,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await Promise.all(databases.map((db) => db.destroy()));
    for (const schema of createdSchemas.reverse())
      await admin.unsafe(`DROP SCHEMA ${quote(schema)} CASCADE`);
    for (const role of createdRoles.reverse()) await admin.unsafe(`DROP ROLE ${quote(role)}`);
  } finally {
    await admin.end();
  }
}
