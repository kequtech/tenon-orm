import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import ts from 'typescript';
import { quote } from '../sql.js';

export class CompositionError extends Error {
  override readonly name = 'TenonCompositionError';
  constructor(detail: string) {
    super(
      `Tenon cannot statically check this composition: ${detail} Use a static query/fragment, or an explicit lint suppression with database tests for every runtime variant.`,
    );
  }
}

/** Match resolved exports, including import aliases, without claiming another library's sql tag. */
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
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return (
    symbol?.getName() === name &&
    Boolean(
      symbol.declarations?.some((declaration) =>
        isTenonModule(declaration.getSourceFile().fileName),
      ),
    )
  );
}

function unwrap(node: ts.Node): ts.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function initializer(node: ts.Identifier, checker: ts.TypeChecker): ts.Expression | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    declaration.parent.flags & ts.NodeFlags.Const
  ) {
    return declaration.initializer;
  }
  return undefined;
}

export function isFragment(type: ts.Type): boolean {
  return type.isUnion()
    ? type.types.some(isFragment)
    : type.getProperty('__tenonFragment') !== undefined;
}

function parameterType(type: ts.Type, checker: ts.TypeChecker): string | undefined {
  if (type.isUnion()) {
    const types = type.types.filter(
      (part) => !(part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)),
    );
    const mapped = types.map((part) => parameterType(part, checker));
    return mapped.length && mapped.every((part) => part !== undefined && part === mapped[0])
      ? mapped[0]
      : undefined;
  }
  if (type.flags & ts.TypeFlags.StringLike) return 'text';
  if (type.flags & ts.TypeFlags.NumberLike) return 'int';
  if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean';
  if (type.flags & ts.TypeFlags.BigIntLike) return 'bigint';
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0];
    const mapped = element && parameterType(element, checker);
    if (mapped) return `${mapped}[]`;
  }
  return undefined;
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
        'sql.join needs a nonempty literal array and a fragment separator for static checking.',
      );
    }
    return list.elements
      .map((item) => renderFragment(item, checker, visited))
      .join(renderFragment(separator, checker, visited));
  }
  throw new CompositionError(
    'Only sql.fragment templates, const fragment references, and sql.join with literal arrays are supported.',
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
        // A string literal type alone is not evidence of the runtime identifier's value.
        let value: ts.Node = unwrap(part);
        const names = new Set<ts.Node>();
        while (ts.isIdentifier(value) && !names.has(value)) {
          names.add(value);
          const next = initializer(value, checker);
          if (!next) break;
          value = unwrap(next);
        }
        if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) {
          throw new CompositionError('Identifier names must be literal strings or const strings.');
        }
        return quote(value.text);
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

function renderValue(node: ts.Node, checker: ts.TypeChecker, seen: Set<ts.Node>): string {
  const type = checker.getTypeAtLocation(node);
  if (isFragment(type)) return renderFragment(node, checker, seen);
  if (isIdentifierType(type)) return renderIdentifier(node, checker, seen);
  if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return '$N';
  const mapped = parameterType(type, checker);
  if (!mapped) {
    throw new CompositionError(
      `Fragment parameter type ${checker.typeToString(type)} is unsupported; place this parameter in the outer sql template.`,
    );
  }
  // SafeQL's plugin protocol numbers $N tokens while respecting SQL quotes/comments.
  return `$N::${mapped}`;
}
