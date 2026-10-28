import { arrayTypes, scalarTypes, valueTypes } from '../driver/types.js';
import type { StatementMetadata } from './catalog.js';
import type {
  DescribedColumn,
  DescribedType,
  DescriptionIssue,
  InspectionContext,
  QueryDescription,
} from './types.js';

/** Convert database metadata to conservative pg types and diagnostics. */
export function queryDescription(
  { statement, types, sources }: StatementMetadata,
  context: InspectionContext,
): QueryDescription {
  const catalog = new Map(types.map((t) => [t.oid, t]));
  const issues = new Map<string, DescriptionIssue>();
  function describeType(oid: number): DescribedType {
    const type = catalog.get(oid);
    if (!type) throw new Error(`PostgreSQL type OID ${oid} was not found.`);
    let readType: string;
    if (type.base) {
      readType = describeType(type.base).readType;
    } else if (type.kind === 'e') {
      readType = type.choices?.map((v) => JSON.stringify(v)).join(' | ') || 'never';
    } else if (Object.hasOwn(arrayTypes, String(oid))) {
      readType = `PgArray<${valueTypes(arrayTypes[String(oid)]!).read}>`;
    } else if (type.schema === 'pg_catalog' && Object.hasOwn(scalarTypes, type.name)) {
      readType = valueTypes(scalarTypes[type.name]!).read;
    } else {
      readType = 'unknown';
      issues.set(`type:${oid}`, {
        code: 'unmapped-type',
        oid,
        postgres: `${type.schema}.${type.name}`,
        message: `No verified pg mapping for ${type.schema}.${type.name} (OID ${oid}).`,
      });
    }
    return { oid, postgres: `${type.schema}.${type.name}`, readType };
  }
  const sourceMap = new Map(sources.map((s) => [`${s.oid}:${s.number}`, s]));
  const names = new Set<string>();
  const columns = statement.fields.map((column): DescribedColumn => {
    if (names.has(column.name)) {
      issues.set(`column:${column.name}`, {
        code: 'duplicate-column',
        column: column.name,
        message: `Duplicate result column ${JSON.stringify(column.name)}; object rows overwrite earlier values.`,
      });
    }
    names.add(column.name);
    const source = sourceMap.get(`${column.tableID}:${column.columnID}`);
    return {
      name: column.name,
      ...describeType(column.dataTypeID),
      nullability: 'unknown',
      source: source
        ? {
            schema: source.schema,
            table: source.table,
            column: source.column,
            notNull: source.notNull,
          }
        : null,
    };
  });
  const parameters = statement.parameters.map(describeType);
  if (columns.length) {
    issues.set('nullability', {
      code: 'nullability-unknown',
      message: 'Result nullability is not established by Describe.',
    });
  }
  const unknown = columns
    .filter((c) => c.readType === 'unknown' || c.readType === 'PgArray<unknown>')
    .map((c) => c.name);
  if (unknown.length) {
    issues.set('shape', {
      code: 'shape-unknown',
      columns: unknown,
      message:
        'An unknown read type does not verify JSON structure or an application-specific result type.',
    });
  }
  const members = columns.map(
    (c) =>
      `  ${JSON.stringify(c.name)}: ${c.readType}${c.readType === 'unknown' ? '' : ' | null'};`,
  );
  const array = columns.some((c) => c.readType.startsWith('PgArray<'))
    ? 'type PgArray<T> = (T | null | PgArray<T>)[];\n'
    : '';
  return {
    context,
    parameters,
    columns,
    rowType:
      columns.length > 0 && names.size === columns.length
        ? `${array}type DescribedRow = {\n${members.join('\n')}\n};`
        : null,
    issues: [...issues.values()],
  };
}
