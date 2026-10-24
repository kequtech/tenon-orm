import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import ts from 'typescript';
import { joinSeparator, quote } from '../sql.js';

import { renderMutation } from './mutations.js';
import { CompositionError, initializer, literalString, unwrap } from './static.js';
export { CompositionError } from './static.js';

/** Recognize Tenon's declarations without claiming another library's SQL tags. */
const tenonModules = new Map<string, boolean>();

function isTenonModule(filename: string): boolean {
  const cached = tenonModules.get(filename);
  if (cached !== undefined) return cached;
  let matches = false;
  if (
    ['query.ts', 'query.d.ts'].includes(basename(filename)) &&
    ['src', 'dist'].includes(basename(dirname(filename)))
  ) {
    try {
      const manifest: unknown = JSON.parse(
        readFileSync(join(dirname(filename), '..', 'package.json'), 'utf8'),
      );
      matches =
        typeof manifest === 'object' &&
        manifest !== null &&
        'name' in manifest &&
        manifest.name === '@kequtech/tenon-orm';
    } catch {
      // An unrelated or unavailable declaration is not a Tenon export.
    }
  }
  tenonModules.set(filename, matches);
  return matches;
}

export function isExport(node: ts.Node, checker: ts.TypeChecker, name: string): boolean {
  // Call signatures retain their declaration through local aliases, object properties,
  // and typeof annotations. Symbol names alone only recognize direct imports.
  return checker
    .getTypeAtLocation(node)
    .getCallSignatures()
    .some((signature) => {
      const declaration = signature.declaration;
      return (
        declaration &&
        ts.isFunctionDeclaration(declaration) &&
        declaration.name?.text === (name === 'sql' ? 'createQuery' : name) &&
        isTenonModule(declaration.getSourceFile().fileName)
      );
    });
}

export function isFragment(type: ts.Type): boolean {
  return type.isUnion()
    ? type.types.some(isFragment)
    : type.getProperty('__tenonFragment') !== undefined;
}

/** Reconstruct only immutable fragments and literal join lists. Never execute application code. */
export function renderFragment(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): string {
  node = unwrap(node);
  if (seen.has(node)) throw new CompositionError('Circular fragment reference.');
  const visited = new Set(seen).add(node);
  if (ts.isIdentifier(node)) {
    const value = initializer(node, checker);
    if (value) return renderFragment(value, checker, visited);
  }
  if (
    ts.isTaggedTemplateExpression(node) &&
    ts.isPropertyAccessExpression(node.tag) &&
    node.tag.name.text === 'fragment' &&
    isExport(node.tag.expression, checker, 'sql')
  ) {
    const template = node.template;
    if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
    let text = template.head.text;
    for (const span of template.templateSpans) {
      text += renderValue(span.expression, checker, visited) + span.literal.text;
    }
    return text;
  }
  if (ts.isCallExpression(node)) {
    for (const kind of ['insertValues', 'assignments'] as const) {
      if (isExport(node.expression, checker, kind)) return renderMutation(kind, node, checker);
    }
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'join' &&
    isExport(node.expression.expression, checker, 'sql')
  ) {
    const [items, separator] = node.arguments;
    const list = items && unwrap(items);
    if (
      !list ||
      !ts.isArrayLiteralExpression(list) ||
      !list.elements.length ||
      !separator ||
      node.arguments.length !== 2
    ) {
      throw new CompositionError(
        'sql.join needs a nonempty literal array and a separator for static checking.',
      );
    }
    const value = literalString(separator, checker);
    if (value === undefined) {
      throw new CompositionError('sql.join separators must be literal strings or const strings.');
    }
    let between: string;
    try {
      between = joinSeparator(value);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new CompositionError(error.message);
    }
    return list.elements.map((item) => renderFragment(item, checker, visited)).join(between);
  }
  if (ts.isCallExpression(node)) {
    throw new CompositionError(
      `Function-generated fragments from ${node.expression.getText()}() are not analyzed; the checker does not inspect function bodies.`,
    );
  }
  if (ts.isConditionalExpression(node)) {
    throw new CompositionError(
      'Conditional fragments are not analyzed; the checker does not choose JavaScript branches, even for literal conditions.',
    );
  }
  if (ts.isIdentifier(node)) {
    throw new CompositionError(
      `Fragment "${node.text}" has no inspectable const initializer; mutable and runtime-supplied fragments are not analyzed.`,
    );
  }
  throw new CompositionError(
    'Only constant sql.fragment templates, literal sql.join arrays, and official mutation helpers are supported. Function-generated fragments and conditional SQL structure are not analyzed.',
  );
}

export function renderIdentifier(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): string {
  node = unwrap(node);
  if (seen.has(node)) throw new CompositionError('Circular identifier reference.');
  const visited = new Set(seen).add(node);
  if (ts.isIdentifier(node)) {
    const value = initializer(node, checker);
    if (value) return renderIdentifier(value, checker, visited);
  }
  if (
    ts.isCallExpression(node) &&
    isExport(node.expression, checker, 'identifier') &&
    node.arguments.length
  ) {
    return node.arguments
      .map((part) => {
        const value = literalString(part, checker);
        if (value === undefined) {
          throw new CompositionError('Identifier names must be literal strings or const strings.');
        }
        try {
          return quote(value);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          throw new CompositionError(error.message);
        }
      })
      .join('.');
  }
  throw new CompositionError('The identifier is selected at runtime.');
}

export function isIdentifierType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(isIdentifierType);
  const symbol = type.getSymbol();
  return (
    symbol?.getName() === 'Identifier' &&
    Boolean(
      symbol.declarations?.some((declaration) =>
        isTenonModule(declaration.getSourceFile().fileName),
      ),
    )
  );
}

export function renderValue(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): string {
  const type = checker.getTypeAtLocation(node);
  if (isFragment(type)) return renderFragment(node, checker, seen);
  if (isIdentifierType(type)) return renderIdentifier(node, checker, seen);
  // Match runtime SQL: PostgreSQL infers parameter types from SQL context, never
  // from JavaScript types. SafeQL numbers these tokens, respecting quotes/comments.
  return '$N';
}
