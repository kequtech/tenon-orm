import type {
  Database,
  OperationOptions,
  QueryResult,
  SqlQuery,
  UnknownRow,
} from '../src/index.js';
import { defineOperation, identifier, sql, unsafeSql } from '../src/index.js';
import type { User } from './fixtures/generated-schema.js';
import { echo_values } from './fixtures/operations.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

async function contracts(db: Database, options?: OperationOptions) {
  type Summary = Pick<User, 'id' | 'email'>;
  const query = sql<Summary>`SELECT id, email FROM public."User" WHERE id = ${42}`;
  const many = await db.query(query, { returns: 'many' });
  const optional = await db.query(query, { returns: 'oneOrNone' });
  const one = await db.query(query, { returns: 'one' });
  const native = await db.query(query);
  const untyped = await db.query(sql`SELECT 1 AS value`, { returns: 'one' });
  const untypedOptional = await db.query(sql`SELECT 1 AS value`, { returns: 'oneOrNone' });
  const untypedMany = await db.query(sql`SELECT 1 AS value`, { returns: 'many' });
  const untypedNative = await db.query(sql`SELECT 1 AS value`);
  const expected: [
    Assert<Equal<typeof many, Summary[]>>,
    Assert<Equal<typeof optional, Summary | undefined>>,
    Assert<Equal<typeof one, Summary>>,
    Assert<Equal<typeof native, QueryResult<Summary>>>,
    Assert<Equal<typeof untyped, UnknownRow>>,
    Assert<Equal<typeof untypedOptional, UnknownRow | undefined>>,
    Assert<Equal<typeof untypedMany, UnknownRow[]>>,
    Assert<Equal<typeof untypedNative, QueryResult<UnknownRow>>>,
  ] = [true, true, true, true, true, true, true, true];
  void expected;
  // @ts-expect-error unknown fields need narrowing
  const unknownNumber: number = untyped.value;
  // @ts-expect-error absence must be handled
  optional.id;
  // @ts-expect-error declared projections determine fields
  one.name;
  // @ts-expect-error sql is a tag, not an ordinary string function
  sql('SELECT 1');
  // @ts-expect-error primitive row types are invalid
  sql<number>`SELECT 1`;
  // @ts-expect-error row absence is determined by the mode
  sql<Summary | undefined>`SELECT 1`;
  // @ts-expect-error plain strings cannot execute accidentally
  await db.query('SELECT 1');
  // @ts-expect-error unknown options are rejected
  await db.query(query, { first: true });
  // @ts-expect-error a non-native generic cannot replace a runtime mode
  await db.query<Summary, 'one'>(query);
  // @ts-expect-error definition modes also require their runtime option
  defineOperation<[], Summary, 'one'>(() => query);
  // Runtime-selected options cannot promise a particular return shape.
  const dynamic = await db.query(query, options);
  const dynamicOperation = await db.run(
    defineOperation(() => query, options),
    [],
  );
  type DynamicResult = QueryResult<Summary> | Summary[] | Summary | undefined;
  const dynamicTypes: [
    Assert<Equal<typeof dynamic, DynamicResult>>,
    Assert<Equal<typeof dynamicOperation, DynamicResult>>,
  ] = [true, true];
  void dynamicTypes;

  const byEmail = defineOperation(
    (email: string, active: boolean) =>
      sql<Summary>`SELECT id, email FROM public."User" WHERE email = ${email} AND active = ${active}`,
    { returns: 'oneOrNone' },
  );
  const all = defineOperation(() => sql<Summary>`SELECT id, email FROM public."User"`, {
    returns: 'many',
  });
  const remove = defineOperation((id: number) => sql`DELETE FROM public."User" WHERE id = ${id}`, {
    affectedRows: { exact: 1 },
  });
  const found = await db.run(byEmail, ['a', true]);
  const echoed = await db.run(echo_values, ['label', true] as const);
  const every = await db.run(all, []);
  const removed = await db.run(remove, [1]);
  const types: [
    Assert<Equal<typeof found, Summary | undefined>>,
    Assert<Equal<typeof echoed, { label: string; enabled: boolean }[]>>,
    Assert<Equal<typeof every, Summary[]>>,
    Assert<Equal<typeof removed, QueryResult<UnknownRow>>>,
  ] = [true, true, true, true];
  void types;
  // @ts-expect-error input order follows factory parameters
  await db.run(byEmail, [true, 'a']);
  // @ts-expect-error missing inputs are rejected
  await db.run(byEmail, ['a']);
  // @ts-expect-error extra inputs are rejected
  await db.run(all, [1]);
  // @ts-expect-error zero-input operations require []
  await db.run(all);
  // @ts-expect-error definitions are references, not names
  await db.run('byEmail', ['a', true]);
  // @ts-expect-error factory must return a query
  defineOperation((email: string) => email);
  // @ts-expect-error asynchronous factories are not supported
  defineOperation(async () => query);
  // @ts-expect-error operation options cannot be overridden at the call site
  await db.run(remove, [1], { affectedRows: { max: 99 } });
  // @ts-expect-error bounds are mutually exclusive
  defineOperation(() => query, { affectedRows: { max: 1, exact: 1 } });
  // @ts-expect-error bounds must be numbers
  await db.query(query, { affectedRows: { max: '1' } });
  // @ts-expect-error a bound is required
  await db.query(query, { affectedRows: {} });
  await db.query(query, { affectedRows: { max: 0 }, returns: 'oneOrNone' });
  await db.query(query, { affectedRows: { exact: 2 }, returns: 'many' });
  await db.query(sql`SELECT * FROM ${identifier('public', 'User')}`);
  await db.query(unsafeSql<Summary>('SELECT id, email FROM public."User" WHERE id = $1', [1]));
  const predicate = sql.fragment`id = ${1}`;
  const composed = await db.query(
    sql<Summary>`SELECT id, email FROM public."User" WHERE ${predicate}`,
    { returns: 'many' },
  );
  const compositionType: Assert<Equal<typeof composed, Summary[]>> = true;
  void compositionType;
  // @ts-expect-error fragments do not declare returned rows
  sql.fragment<Summary>`id = 1`;
  // @ts-expect-error fragments are not executable
  await db.query(predicate);
  // @ts-expect-error separators cannot be raw strings
  sql.join([predicate], ' AND ');
  // @ts-expect-error a query's row type does not describe a fragment or enclosing SELECT
  sql.join([query], sql.fragment`, `);
  // @ts-expect-error unsafe SQL still requires an explicit array
  unsafeSql('SELECT 1');
  const contextual = sql`SELECT id FROM public."User"` satisfies SqlQuery<UnknownRow>;
  const context: Assert<Equal<typeof contextual, SqlQuery<UnknownRow>>> = true;
  void context;
  await db.transaction(async (tx) => {
    const row = await tx.run(byEmail, ['a', true]);
    const same: Assert<Equal<typeof row, Summary | undefined>> = true;
    void same;
    await tx.query(query, { returns: 'one' });
    // @ts-expect-error transaction clients do not own the pool
    await tx.close();
    // @ts-expect-error no nested callback transactions
    await tx.transaction(async () => {});
  });
}
void contracts;
