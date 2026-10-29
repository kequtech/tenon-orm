import ts from 'typescript';
import type { QueryDescription } from '../inspection/types.js';
import { location, type Project } from './project.js';
import type { QueryNode, QueryVariant } from './source.js';
import type { CheckDiagnostic } from './types.js';

function kinds(project: Project, type: ts.Type, seen = new Set<ts.Type>()): Set<string> {
  if (seen.has(type)) return new Set();
  seen.add(type);
  if (type.isUnion())
    return new Set(type.types.flatMap((member) => [...kinds(project, member, seen)]));
  if (type.isIntersection())
    return new Set(type.types.flatMap((member) => [...kinds(project, member, seen)]));
  if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never))
    return new Set();
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))
    return new Set(['unknown']);
  for (const [flag, name] of [
    [ts.TypeFlags.StringLike, 'string'],
    [ts.TypeFlags.NumberLike, 'number'],
    [ts.TypeFlags.BigIntLike, 'bigint'],
    [ts.TypeFlags.BooleanLike, 'boolean'],
  ] as const)
    if (type.flags & flag) return new Set([name]);
  if (project.checker.isArrayType(type) || project.checker.isTupleType(type))
    return new Set(['array']);
  return new Set(['object']);
}

function disjoint(project: Project, actual: ts.Type, expected: ts.Type, depth = 0): boolean {
  if (depth > 8) return false;
  const a = kinds(project, actual),
    b = kinds(project, expected);
  if (!b.size) return true;
  if (a.has('unknown') || b.has('unknown')) return false;
  if (![...a].some((kind) => b.has(kind))) return true;
  if (a.size === 1 && a.has('array') && b.size === 1 && b.has('array')) {
    const elements = (type: ts.Type): ts.Type[] =>
      (type.isUnion() ? type.types : [type]).flatMap((part) => {
        const element = project.checker.getIndexTypeOfType(part, ts.IndexKind.Number);
        return element ? [element] : [];
      });
    const actualElements = elements(actual),
      expectedElements = elements(expected);
    return (
      actualElements.length > 0 &&
      expectedElements.length > 0 &&
      actualElements.every((a) => expectedElements.every((b) => disjoint(project, a, b, depth + 1)))
    );
  }
  if (a.size === 1 && a.has('object') && b.size === 1 && b.has('object')) {
    for (const property of actual.getProperties()) {
      const other = expected.getProperty(property.name);
      if (
        !other ||
        (property.flags & ts.SymbolFlags.Optional && other.flags & ts.SymbolFlags.Optional)
      )
        continue;
      const context = project.selected[0]!;
      if (
        disjoint(
          project,
          project.checker.getTypeOfSymbolAtLocation(property, context),
          project.checker.getTypeOfSymbolAtLocation(other, context),
          depth + 1,
        )
      )
        return true;
    }
  }
  return false;
}

function rowType(project: Project, query: QueryNode): ts.Type | undefined {
  const explicit = query.typeArguments?.[0];
  if (explicit) return project.checker.getTypeFromTypeNode(explicit);
  const contextual = project.checker.getContextualType(query);
  const type = contextual ?? project.checker.getTypeAtLocation(query);
  const property = type.getProperty('__rowType');
  return property
    ? project.checker.getNonNullableType(project.checker.getTypeOfSymbolAtLocation(property, query))
    : undefined;
}

/** Compare non-NULL representations; nullability and value refinements remain explicit limitations. */
export function compareContracts(
  project: Project,
  query: QueryNode,
  variant: QueryVariant,
  description: QueryDescription,
  readTypes: Readonly<Record<number, string>>,
): CheckDiagnostic[] {
  const checker = project.checker;
  const at = location(query);
  const diagnostics: CheckDiagnostic[] = [];
  for (const [index, parameter] of variant.parameters.entries()) {
    const expected = description.parameters[index];
    if (!expected) continue;
    const inputKinds = kinds(project, parameter.type);
    if (inputKinds.has('string') || inputKinds.has('number')) {
      diagnostics.push({
        ...location(parameter.node),
        kind: 'unproven',
        code: 'parameter-value-unproven',
        parameter: index + 1,
        expected: expected.postgres,
        observed: checker.typeToString(parameter.type),
        message: `Parameter ${index + 1}${parameter.field ? ` (${parameter.field})` : ''}: ${checker.typeToString(parameter.type)} does not prove PostgreSQL ranges or textual formats for ${expected.postgres}.`,
      });
    }
  }
  if (description.columns.length)
    diagnostics.push({
      ...at,
      kind: 'unproven',
      code: 'nullability-unproven',
      message:
        'Describe does not establish result nullability; column representation checks exclude SQL NULL.',
    });
  for (const issue of description.issues) {
    if (issue.code === 'duplicate-column')
      diagnostics.push({
        ...at,
        kind: 'mismatch',
        code: issue.code,
        resultColumn: issue.column,
        message: issue.message,
      });
  }
  const declared = rowType(project, query);
  if (
    !declared ||
    declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)
  ) {
    diagnostics.push({
      ...at,
      kind: 'unproven',
      code: 'result-type-unproven',
      message: 'No concrete declared result shape was resolved.',
    });
    return diagnostics;
  }
  const alternatives = declared.isUnion() ? declared.types : [declared];
  const results = alternatives.map((row) => {
    const findings: CheckDiagnostic[] = [];
    for (const property of row.getProperties()) {
      if (
        !(property.flags & ts.SymbolFlags.Optional) &&
        !description.columns.some((column) => column.name === property.name)
      ) {
        findings.push({
          ...at,
          kind: 'mismatch',
          code: 'missing-column',
          resultColumn: property.name,
          expected: checker.typeToString(checker.getTypeOfSymbolAtLocation(property, query)),
          observed: 'absent',
          message: `Required result property ${JSON.stringify(property.name)} is absent from the SQL result.`,
        });
      }
    }
    for (const column of description.columns) {
      const property = row.getProperty(column.name);
      const expected = property
        ? checker.getTypeOfSymbolAtLocation(property, query)
        : checker.getIndexTypeOfType(row, ts.IndexKind.String);
      if (!expected) continue; // Structural result types may omit additional selected columns.
      const representation = readTypes[column.oid] ?? column.readType;
      const actual = project.types.get(representation);
      const common = {
        ...at,
        resultColumn: column.name,
        expected: checker.typeToString(expected),
        observed: representation,
      };
      if (!actual || actual.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) {
        findings.push({
          ...common,
          kind: 'unproven',
          code: 'result-representation-unproven',
          message: `Column ${JSON.stringify(column.name)} has an unresolved decoder representation or JSON shape; ${checker.typeToString(expected)} is unproven.`,
        });
        continue;
      }
      const nonnull = checker.getNonNullableType(expected);
      if (nonnull.flags & ts.TypeFlags.Any) {
        findings.push({
          ...common,
          kind: 'unproven',
          code: 'result-type-unproven',
          message: `Column ${JSON.stringify(column.name)} is declared as any.`,
        });
      } else if (!checker.isTypeAssignableTo(actual, nonnull)) {
        const mismatch = disjoint(project, actual, nonnull);
        findings.push({
          ...common,
          kind: mismatch ? 'mismatch' : 'unproven',
          code: mismatch ? 'result-type-mismatch' : 'result-refinement-unproven',
          message: `Column ${JSON.stringify(column.name)} decodes as ${representation}; its declared type ${checker.typeToString(expected)} ${mismatch ? 'contradicts that representation' : 'requires a refinement Describe cannot prove'}.`,
        });
      }
    }
    return findings;
  });
  const compatible = results.filter(
    (findings) => !findings.some((finding) => finding.kind === 'mismatch'),
  );
  if (compatible.length) {
    compatible.sort((a, b) => a.length - b.length);
    diagnostics.push(...compatible[0]!);
  } else if (results.length === 1) diagnostics.push(...results[0]!);
  else {
    diagnostics.push({
      ...at,
      kind: 'mismatch',
      code: 'result-union-mismatch',
      expected: checker.typeToString(declared),
      observed: description.rowType ?? 'no row declaration',
      message: `No declared result union member matches this SQL variant: ${results
        .map((findings) =>
          findings
            .filter((finding) => finding.kind === 'mismatch')
            .map((finding) => finding.message)
            .join(' '),
        )
        .join(' / ')}`,
    });
  }
  return diagnostics;
}
