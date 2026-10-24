import ts from 'typescript';

export class CompositionError extends Error {
  override readonly name = 'TenonCompositionError';
  constructor(readonly detail: string) {
    super(
      `Tenon cannot statically check this composition: ${detail} Use a static query/fragment, or an explicit lint suppression with database tests for every runtime variant.`,
    );
  }
}

export function unwrap(node: ts.Node): ts.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    node = node.expression;
  return node;
}

export function initializer(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  return declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    declaration.parent.flags & ts.NodeFlags.Const
    ? declaration.initializer
    : undefined;
}

/** Follow immutable const aliases only. Never inspect functions or evaluate expressions. */
function constant(node: ts.Node, checker: ts.TypeChecker): ts.Node {
  const seen = new Set<ts.Node>();
  node = unwrap(node);
  while (ts.isIdentifier(node)) {
    if (seen.has(node)) throw new CompositionError('Circular const reference.');
    if (seen.size >= 1000) throw new CompositionError('Const resolution exceeds 1000 references.');
    seen.add(node);
    const value = initializer(node, checker);
    if (!value) break;
    node = unwrap(value);
  }
  return node;
}

export function literalString(node: ts.Node, checker: ts.TypeChecker): string | undefined {
  const value = constant(node, checker);
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
    ? value.text
    : undefined;
}

export function isUndefined(node: ts.Node, checker: ts.TypeChecker): boolean {
  const value = constant(node, checker);
  return (
    ts.isIdentifier(value) &&
    value.text === 'undefined' &&
    !checker.getSymbolAtLocation(value)?.declarations?.length
  );
}
