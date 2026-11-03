import * as ts from './compiler.js';
import type { QueryDescription } from '../inspection/types.js';
import { location, type Project } from './project.js';
import type { QueryNode } from './source.js';
import type { CheckDiagnostic } from './types.js';

function kinds(project: Project, type: ts.Type, seen = new Set<ts.Type>()): Set<string> {
  if (seen.has(type)) return new Set();
  seen.add(type);
  if (type.isUnionType())
    return new Set(type.getTypes().flatMap((member) => [...kinds(project, member, seen)]));
  if (type.isIntersectionType())
    return new Set(type.getTypes().flatMap((member) => [...kinds(project, member, seen)]));
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
  if (expected.isUnionType())
    return expected.getTypes().every((member) => disjoint(project, actual, member, depth + 1));
  if (actual.isStringLiteralType() && expected.isStringLiteralType())
    return actual.value !== expected.value;
  const a = kinds(project, actual),
    b = kinds(project, expected);
  if (!b.size) return true;
  if (a.has('unknown') || b.has('unknown')) return false;
  if (![...a].some((kind) => b.has(kind))) return true;
  if (a.size === 1 && a.has('array') && b.size === 1 && b.has('array')) {
    const elements = (type: ts.Type): ts.Type[] =>
      (type.isUnionType() ? type.getTypes() : [type]).flatMap((part) => {
        const element = project.checker
          .getIndexInfosOfType(part)
          .find((info) => info.keyType.flags & ts.TypeFlags.Number)?.valueType;
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
    for (const property of project.checker.getPropertiesOfType(actual)) {
      const other = project.checker.getPropertyOfType(expected, property.name);
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
  const property = type && project.checker.getPropertyOfType(type, '__rowType');
  return property
    ? project.checker.getNonNullableType(project.checker.getTypeOfSymbolAtLocation(property, query))
    : undefined;
}

/** Compare non-NULL representations; nullability and value refinements remain explicit limitations. */
export function compareContracts(
  project: Project,
  query: QueryNode,
  description: QueryDescription,
  readTypes: Readonly<Record<number, string>>,
): CheckDiagnostic[] {
  project.addTypes(
    description.columns.flatMap(
      (column) => column.enumLabels?.map((label) => JSON.stringify(label)) ?? [],
    ),
  );
  const checker = project.checker;
  const at = location(query);
  const diagnostics: CheckDiagnostic[] = [];
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
  const alternatives = declared.isUnionType() ? declared.getTypes() : [declared];
  const results = alternatives.map((row) => {
    const findings: CheckDiagnostic[] = [];
    for (const property of checker.getPropertiesOfType(row)) {
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
      const property = checker.getPropertyOfType(row, column.name);
      const expected = property
        ? checker.getTypeOfSymbolAtLocation(property, query)
        : checker.getIndexInfosOfType(row).find((info) => info.keyType.flags & ts.TypeFlags.String)
            ?.valueType;
      if (!expected) continue; // Structural result types may omit additional selected columns.
      const representation = readTypes[column.oid] ?? column.readType;
      const actual = project.types.get(representation);
      const actualTypes =
        column.enumLabels?.map((label) => project.types.get(JSON.stringify(label))!) ??
        (actual && !(actual.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any))
          ? [actual]
          : undefined);
      const common = {
        ...at,
        resultColumn: column.name,
        expected: checker.typeToString(expected),
        observed: representation,
      };
      if (!actualTypes) {
        findings.push({
          ...common,
          kind: 'unproven',
          code: 'result-representation-unproven',
          message: `Column ${JSON.stringify(column.name)} has an unresolved decoder representation or JSON shape; ${checker.typeToString(expected)} is unproven.`,
        });
        continue;
      }
      const nonnull = checker.getNonNullableType(expected) ?? expected;
      if (nonnull.flags & ts.TypeFlags.Any) {
        findings.push({
          ...common,
          kind: 'unproven',
          code: 'result-type-unproven',
          message: `Column ${JSON.stringify(column.name)} is declared as any.`,
        });
      } else if (!actualTypes.every((type) => checker.isTypeAssignableTo(type, nonnull))) {
        const mismatch = actualTypes.every((type) => disjoint(project, type, nonnull));
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
