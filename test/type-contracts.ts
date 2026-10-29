import type {
  ConnectionOptions,
  CloseOptions,
  Database,
  DescribeOptions,
  QueryDescription,
  QueryClient,
  QueryOptions,
  QueryResult,
  SqlQuery,
  UnknownRow,
} from '../src/index.js';
import {
  CardinalityError,
  createTenon,
  describeQuery,
  identifier,
  sql,
  unsafeSql,
} from '../src/index.js';
import type { User } from './fixtures/models.js';
import { echoValues } from './fixtures/queries.js';
import { checkQueries, type CheckReport } from '../src/check.js';

async function checkingContracts(connection: string) {
  const report: CheckReport = await checkQueries({
    connection,
    target: 'queries.ts:23',
    project: 'tsconfig.json',
    readTypes: { 23: 'string' },
  });
  const ok: boolean = report.ok;
  // @ts-expect-error use file:line rather than a separate line option
  await checkQueries({ connection, line: 23 });
  // @ts-expect-error readTypes values must be TypeScript type expressions
  await checkQueries({ connection, readTypes: { 23: 42 } });
  return ok;
}
void checkingContracts;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

async function contracts(db: Database, options?: QueryOptions) {
  const nativeRows = await db.native.queryClassic<{ value: number }>(
    'SELECT $1::integer AS value',
    [1],
  );
  const nativeType: Assert<Equal<(typeof nativeRows.rows)[number], { value: number }>> = true;
  void nativeType;
  const client = await db.native.acquire();
  await client.release();
  // @ts-expect-error the driver reference is readonly
  db.native = db.native;
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
    Assert<Equal<typeof many, readonly Summary[]>>,
    Assert<Equal<typeof optional, Summary | undefined>>,
    Assert<Equal<typeof one, Summary>>,
    Assert<Equal<typeof native, QueryResult<Summary>>>,
    Assert<Equal<typeof untyped, UnknownRow>>,
    Assert<Equal<typeof untypedOptional, UnknownRow | undefined>>,
    Assert<Equal<typeof untypedMany, readonly UnknownRow[]>>,
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
  // Runtime-selected options cannot promise a particular return shape.
  const dynamic = await db.query(query, options);
  type DynamicResult = QueryResult<Summary> | readonly Summary[] | Summary | undefined;
  const dynamicType: Assert<Equal<typeof dynamic, DynamicResult>> = true;
  void dynamicType;

  const byEmail = (client: QueryClient, { email, active }: { email: string; active: boolean }) =>
    client.query(
      sql<Summary>`SELECT id, email FROM public."User" WHERE email = ${email} AND active = ${active}`,
      { returns: 'oneOrNone' },
    );
  const all = (client: QueryClient) =>
    client.query(sql<Summary>`SELECT id, email FROM public."User"`, {
      returns: 'many',
    });
  const remove = (client: QueryClient, { id }: { id: number }) =>
    client.query(sql`DELETE FROM public."User" WHERE id = ${id}`, { affectedRows: { exact: 1 } });
  const found = await byEmail(db, { email: 'a', active: true });
  const echoed = await echoValues(db, { label: 'label', enabled: true });
  const every = await all(db);
  const removed = await remove(db, { id: 1 });
  const types: [
    Assert<Equal<typeof found, Summary | undefined>>,
    Assert<Equal<typeof echoed, readonly { label: string; enabled: boolean }[]>>,
    Assert<Equal<typeof every, readonly Summary[]>>,
    Assert<Equal<typeof removed, QueryResult<UnknownRow>>>,
  ] = [true, true, true, true];
  void types;
  // @ts-expect-error query functions preserve their named input contract
  await byEmail(db, { email: true, active: 'a' });
  // @ts-expect-error required fields cannot be omitted
  await byEmail(db, { email: 'a' });
  // @ts-expect-error bounds are mutually exclusive
  await db.query(query, { affectedRows: { max: 1, exact: 1 } });
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
  const compositionType: Assert<Equal<typeof composed, readonly Summary[]>> = true;
  void compositionType;
  // @ts-expect-error fragments do not declare returned rows
  sql.fragment<Summary>`id = 1`;
  // @ts-expect-error fragments are not executable
  await db.query(predicate);
  sql.join([predicate], 'AND');
  sql.join([predicate], 'OR');
  sql.join([predicate], ',');
  // @ts-expect-error separators must be one of the supported strings
  sql.join([predicate], ' AND ');
  // @ts-expect-error fragment separators are no longer supported
  sql.join([predicate], sql.fragment` AND `);
  // @ts-expect-error a query's row type does not describe a fragment or enclosing SELECT
  sql.join([query], ',');
  // @ts-expect-error unsafe SQL still requires an explicit array
  unsafeSql('SELECT 1');
  const contextual = sql`SELECT id FROM public."User"` satisfies SqlQuery<UnknownRow>;
  const context: Assert<Equal<typeof contextual, SqlQuery<UnknownRow>>> = true;
  void context;
  await db.transaction(async (tx) => {
    // @ts-expect-error native access is pool-level and is not exposed on transactions
    tx.native;
    const row = await byEmail(tx, { email: 'a', active: true });
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

async function inspectionContracts(db: Database) {
  const input = {
    connection: 'postgresql://unused',
    query: sql`SELECT ${1}::integer AS id`,
    session: { searchPath: 'public', timeZone: 'UTC' },
    timeouts: { statementMs: 5000 },
  } satisfies DescribeOptions;
  const result: QueryDescription = await describeQuery(input);
  const nullable: 'unknown' = result.columns[0]!.nullability;
  const declaration: string | null = result.rowType;
  for (const issue of result.issues) {
    if (issue.code === 'duplicate-column') {
      const column: string = issue.column;
      void column;
    } else if (issue.code === 'unmapped-type') {
      const oid: number = issue.oid;
      void oid;
    }
  }
  await describeQuery({ connection: input.connection, query: input.query.text });
  // @ts-expect-error inspection does not borrow a database or transaction connection
  await describeQuery({ connection: db, query: input.query });
  // @ts-expect-error sessions accept strings, not arbitrary pool parser settings
  await describeQuery({ connection: input.connection, query: input.query, session: { role: 1 } });
  // @ts-expect-error descriptions do not prove a non-null result
  const proven: false = result.columns[0]!.nullability;
  void [nullable, declaration];
}
void inspectionContracts;

// Mutation columns preserve known object keys without widening their input types.
function mutationContracts() {
  interface Input {
    name: string;
    score?: number;
  }
  const row: Input = { name: 'typed' };
  sql.insertValues(row, ['name', 'score']);
  sql.assignments(row, ['name']);
  sql.insertValues([{ name: 'one' }, { score: 2 }], ['name', 'score']);
  // @ts-expect-error an explicit column must belong to the input type
  sql.insertValues(row, ['missing']);
  // @ts-expect-error an explicit column must belong to the input type
  sql.assignments(row, ['missing']);
  // @ts-expect-error mutations require objects
  sql.insertValues('value');
  // @ts-expect-error updates require one object, not a scalar
  sql.assignments(1);
}

function connectionContracts() {
  const options: ConnectionOptions = {
    maxConnections: 2,
    connectTimeoutMs: 5000,
    applicationName: 'tenon',
  };
  const connection = {
    ...options,
    connectionString: 'postgresql://unused',
  } satisfies ConnectionOptions;
  const db = createTenon({ connection });
  // @ts-expect-error pgclear connectionString requires a string
  const invalid: ConnectionOptions = { connectionString: 42 };
  const inspection: DescribeOptions = {
    connection: connection.connectionString,
    query: 'SELECT 1',
    session: { role: undefined, searchPath: undefined, timeZone: undefined },
    timeouts: { connectMs: undefined, statementMs: undefined, lockMs: undefined },
  };
  const omitted: DescribeOptions = {
    connection: connection.connectionString,
    query: 'SELECT 1',
    session: undefined,
    timeouts: undefined,
  };
  void [db, options, connection, invalid, inspection, omitted];
}

async function shutdownContracts(db: Database) {
  const options: CloseOptions = { timeoutMs: 5000 };
  const closed: Promise<void> = db.close(options);
  await db.close({ timeoutMs: undefined });
  // @ts-expect-error close uses milliseconds as a number
  await db.close({ timeoutMs: '5s' });
  // @ts-expect-error driver seconds are not a Tenon close option
  await db.close({ timeout: 5 });
  const error = new CardinalityError('one', 0, 'required-user');
  const code: 'TENON_CARDINALITY_MISMATCH' = error.code;
  const expected: 'one' | 'oneOrNone' = error.expected;
  const actual: number = error.actual;
  const label: string | undefined = error.label;
  void [closed, code, expected, actual, label];
}
