import type { CodecRegistry } from '@kequtech/pgclear';
import type { StatementMetadata } from './catalog.js';
import type {
  DescribedColumn,
  DescribedType,
  DescriptionIssue,
  InspectionContext,
  QueryDescription,
} from './types.js';

/** Read representations follow the selected registry's wire OIDs, not catalog base types. */
export function queryDescription(
  { statement, types, sources }: StatementMetadata,
  context: InspectionContext,
  codecs: CodecRegistry,
): QueryDescription {
  const catalog = new Map(types.map((t) => [t.oid, t]));
  const issues = new Map<string, DescriptionIssue>();
  function describeType(oid: number): DescribedType {
    const type = catalog.get(oid);
    if (!type) throw new Error(`PostgreSQL type OID ${oid} was not found.`);
    const representation = codecs.typescript(oid);
    const readType = representation ?? 'unknown';
    if (representation === undefined) {
      issues.set(`type:${oid}`, {
        code: 'unmapped-type',
        oid,
        postgres: `${type.schema}.${type.name}`,
        message: `The selected pgclear registry cannot identify the decoder representation for ${type.schema}.${type.name} (OID ${oid}). Supply an application type for this custom decoder.`,
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
        message: `Duplicate result column ${JSON.stringify(column.name)}; pgclear rejects duplicate object columns.`,
      });
    }
    names.add(column.name);
    const source = sourceMap.get(`${column.tableOid}:${column.columnAttribute}`);
    return {
      name: column.name,
      ...describeType(column.dataTypeOid),
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
  const parameters = statement.parameterTypes.map(describeType);
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
    ? 'type PgArray<T> = readonly (T | null | PgArray<T>)[];\n'
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
