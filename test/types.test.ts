import { createTenon, define } from '../src/index.js';
import type { QueryResult, OperationRegistry, Database } from '../src/index.js';
import { echo_values } from './operation-fixtures.js';
import type { User } from './generated-schema.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

async function checkOperationTypes() {
  type Summary = Pick<User, 'id' | 'email'>;
  const operations = {
    echo_values,
    users_by_email: define<Summary, [email: User['email'], active: User['active']]>('SELECT id, email FROM "User" WHERE email = $1 AND active = $2', { returns: 'many' }),
    all_users: define<Summary>('SELECT id, email FROM "User"', { returns: 'many' }),
    user_by_email: define<Summary, [email: string]>('SELECT id, email FROM "User" WHERE email = $1', { returns: 'one' }),
    required_user_by_email: define<Summary, [email: string]>('SELECT id, email FROM "User" WHERE email = $1', { returns: 'requiredOne' }),
    delete_user: define<never, [id: number]>('DELETE FROM "User" WHERE id = $1', { returns: 'native' }),
    raw_user: define<Summary, [email: string]>('INSERT INTO "User" (email) VALUES ($1) RETURNING id, email'),
    clear_users: define('DELETE FROM "User"'),
    undeclared_many: define('SELECT id FROM "User"', { returns: 'many' }),
    undeclared_one: define('SELECT id FROM "User"', { returns: 'one' }),
    undeclared_required: define('SELECT id FROM "User"', { returns: 'requiredOne' }),
  } satisfies OperationRegistry;
  const db = createTenon({ connection: 'unused', operations });
  const users = await db.run('users_by_email', ['alice', true]);
  const echoed = await db.run('echo_values', ['hello', false]);
  const all = await db.run('all_users', []);
  const optional = await db.run('user_by_email', ['alice']);
  const required = await db.run('required_user_by_email', ['alice']);
  const command = await db.run('delete_user', [1]);
  const raw = await db.run('raw_user', ['alice']);
  const defaultCommand = await db.run('clear_users', []);
  const undeclaredMany = await db.run('undeclared_many', []);
  const undeclaredOne = await db.run('undeclared_one', []);
  const undeclaredRequired = db.run('undeclared_required', []);
  type Users = Assert<Equal<typeof users, Summary[]>>;
  type Echoed = Assert<Equal<typeof echoed, { label: string; enabled: boolean }[]>>;
  type All = Assert<Equal<typeof all, Summary[]>>;
  type Optional = Assert<Equal<typeof optional, Summary | undefined>>;
  type Required = Assert<Equal<typeof required, Summary>>;
  type Command = Assert<Equal<typeof command, QueryResult<never>>>;
  type Raw = Assert<Equal<typeof raw, QueryResult<Summary>>>;
  type DefaultCommand = Assert<Equal<typeof defaultCommand, QueryResult<never>>>;
  type UndeclaredMany = Assert<Equal<typeof undeclaredMany, never[]>>;
  type UndeclaredOne = Assert<Equal<typeof undeclaredOne, undefined>>;
  type UndeclaredRequired = Assert<Equal<typeof undeclaredRequired, Promise<never>>>;
  const contracts: [Users, Echoed, All, Optional, Required, Command, Raw, DefaultCommand, UndeclaredMany, UndeclaredOne, UndeclaredRequired] = [true, true, true, true, true, true, true, true, true, true, true];
  void contracts;
  const readonlyInput = ['hello', false] as const;
  await db.run('echo_values', readonlyInput);
  // @ts-expect-error operation names are inferred from the registry
  await db.run('missing', []);
  // @ts-expect-error inputs are always supplied as an explicit array
  await db.run('users_by_email', 'alice', true);
  // @ts-expect-error input tuples require every mandatory position
  await db.run('users_by_email', ['alice']);
  // @ts-expect-error extra parameters are rejected
  await db.run('users_by_email', ['alice', true, 1]);
  // @ts-expect-error parameter types and order match the selected operation
  await db.run('users_by_email', [true, 'alice']);
  // @ts-expect-error zero-input operations still require an explicit empty array
  await db.run('all_users');
  // @ts-expect-error the default input tuple accepts no parameters
  await db.run('clear_users', [1]);
  // @ts-expect-error a defaulted input tuple remains empty even with a declared row type
  await db.run('all_users', ['alice']);
  // @ts-expect-error results contain only the declared database projection
  users[0]!.name;
  // @ts-expect-error undeclared row fields cannot be accessed
  defaultCommand.rows[0]!.id;
  // @ts-expect-error database clients expose no table clients
  db.User;
  // @ts-expect-error row types cannot include absence; one adds undefined automatically
  define<Summary | undefined>('SELECT id, email FROM "User"', { returns: 'one' });
  // @ts-expect-error a database row cannot itself be null
  define<Summary | null>('SELECT id, email FROM "User"', { returns: 'one' });
  // @ts-expect-error primitive values are not row types
  define<string>('SELECT id FROM "User"');
  // @ts-expect-error unsupported return modes are rejected
  define<Summary>('SELECT id, email FROM "User"', { returns: 'first' });
  // @ts-expect-error unknown operation options are rejected
  define<Summary>('SELECT id, email FROM "User"', { returns: 'many', first: true });
  // @ts-expect-error the old command mode is removed
  define('DELETE FROM "User"', { returns: 'command' });
  const commandRows: never[] = command.rows;
  const commandName: string = command.command;
  const rowCount: number | null = command.rowCount;
  void [commandRows, commandName, rowCount];
  // @ts-expect-error optional row results must be checked before accessing fields
  optional.id;
  required.id;
  // @ts-expect-error inputs must be an array or tuple
  define<Summary, string>('SELECT id, email FROM "User"');
  // @ts-expect-error registry values must be typed operation definitions
  createTenon({ connection: 'unused', operations: { invalid: { sql: 'SELECT 1' } } });
  await db.transaction(async tx => {
    const rows = await tx.run('users_by_email', ['alice', true]);
    const optionalRow = await tx.run('user_by_email', ['alice']);
    const requiredRow = await tx.run('required_user_by_email', ['alice']);
    const commandResult = await tx.run('delete_user', [1]);
    type Rows = Assert<Equal<typeof rows, Summary[]>>;
    type OptionalRow = Assert<Equal<typeof optionalRow, Summary | undefined>>;
    type RequiredRow = Assert<Equal<typeof requiredRow, Summary>>;
    type TransactionCommand = Assert<Equal<typeof commandResult, QueryResult<never>>>;
    const contract: [Rows, OptionalRow, RequiredRow, TransactionCommand] = [true, true, true, true];
    void contract;
    // @ts-expect-error transaction clients preserve the same input contract
    await tx.run('users_by_email', ['alice', 1]);
  });
  // @ts-expect-error registered result modes cannot be overridden at the call site
  await db.run('users_by_email', ['alice', true], { returns: 'one' });
  // @ts-expect-error runtime schema registration was removed with convenience CRUD
  createTenon({ connection: 'unused', schema: {} });
  // @ts-expect-error namespace is a migration/generation setting; SQL names are explicit
  createTenon({ connection: 'unused', namespace: 'example' });
}
void checkOperationTypes;

async function checkInlineTypes(db: Database) {
  type Summary = Pick<User, 'id' | 'email'>;
  const many = await db.sql<Summary>('SELECT id, email FROM users WHERE active = $1', [true], { returns: 'many' });
  const optional = await db.sql<Summary>('SELECT id, email FROM users WHERE id = $1', [1], { returns: 'one' });
  const required = await db.sql<Summary>('SELECT id, email FROM users WHERE id = $1', [1], { returns: 'requiredOne' });
  const command = await db.sql('DELETE FROM users WHERE id = $1', [1]);
  const raw = await db.sql<Summary>('UPDATE users SET active = $1 RETURNING id, email', [true], { returns: 'native' });
  const implicitNative = await db.sql<Summary>('SELECT id, email FROM users', []);
  const undeclaredMany = await db.sql('SELECT id FROM users', [], { returns: 'many' });
  const undeclaredOne = await db.sql('SELECT id FROM users', [], { returns: 'one' });
  const undeclaredRequired = db.sql('SELECT id FROM users', [], { returns: 'requiredOne' });
  const contextualNative = db.sql('SELECT id FROM users', []) satisfies Promise<QueryResult<Summary>>;
  type Many = Assert<Equal<typeof many, Summary[]>>;
  type Optional = Assert<Equal<typeof optional, Summary | undefined>>;
  type Required = Assert<Equal<typeof required, Summary>>;
  type Command = Assert<Equal<typeof command, QueryResult<never>>>;
  type Raw = Assert<Equal<typeof raw, QueryResult<Summary>>>;
  type ImplicitNative = Assert<Equal<typeof implicitNative, QueryResult<Summary>>>;
  type UndeclaredMany = Assert<Equal<typeof undeclaredMany, never[]>>;
  type UndeclaredOne = Assert<Equal<typeof undeclaredOne, undefined>>;
  type UndeclaredRequired = Assert<Equal<typeof undeclaredRequired, Promise<never>>>;
  type ContextualNative = Assert<Equal<typeof contextualNative, Promise<QueryResult<never>>>>;
  const contracts: [Many, Optional, Required, Command, Raw, ImplicitNative, UndeclaredMany, UndeclaredOne, UndeclaredRequired, ContextualNative] = [true, true, true, true, true, true, true, true, true, true];
  void contracts;
  await db.sql<object>('SELECT 1', [] as const, { returns: 'many' });
  // @ts-expect-error the old command mode is removed
  await db.sql('DELETE FROM users', [], { returns: 'command' });
  // @ts-expect-error inline inputs must be explicit arrays
  await db.sql<Summary>('SELECT id, email FROM users', 'alice', { returns: 'many' });
  // @ts-expect-error zero-input queries still take an explicit empty array
  await db.sql<Summary>('SELECT id, email FROM users');
  // @ts-expect-error options do not replace the explicit input array
  await db.sql<Summary>('SELECT id, email FROM users', { returns: 'many' });
  // @ts-expect-error row types cannot include absence; one adds undefined automatically
  await db.sql<Summary | undefined>('SELECT id, email FROM users', [], { returns: 'one' });
  // @ts-expect-error primitive values are not row types
  await db.sql<number>('SELECT id FROM users', []);
  // @ts-expect-error unsupported result modes are rejected
  await db.sql<Summary>('SELECT id, email FROM users', [], { returns: 'first' });
  // @ts-expect-error unknown behavior options are rejected
  await db.sql<Summary>('SELECT id, email FROM users', [], { returns: 'many', limit: 1 });
  // @ts-expect-error row shape is the declared SQL projection
  many[0]!.name;
  // @ts-expect-error undeclared row fields cannot be accessed
  command.rows[0]!.id;
  // @ts-expect-error optional results must be checked
  optional.id;
  // @ts-expect-error the old raw-query alias is removed
  await db.query('SELECT 1');
  // @ts-expect-error no runtime schema metadata exists
  db.schema;
  await db.transaction(async tx => {
    const rows = await tx.sql<Summary>('SELECT id, email FROM users', [], { returns: 'many' });
    type Rows = Assert<Equal<typeof rows, Summary[]>>;
    const contract: Rows = true;
    void contract;
    // @ts-expect-error transaction clients cannot start another transaction
    await tx.transaction(async () => {});
    // @ts-expect-error only the owner manages the pool lifecycle
    await tx.close();
  });
}
void checkInlineTypes;
