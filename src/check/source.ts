import { builtin } from '@kequtech/pgclear';
import ts from 'typescript';
import { joinSeparator, quote } from '../sql.js';
import { location, symbol, type Project } from './project.js';
import type { CheckDiagnostic } from './types.js';

export const variantLimit = 16;
type QueryNode = ts.TaggedTemplateExpression | ts.CallExpression;
type Choice = ts.Symbol | ts.Node;
export interface Binding {
  readonly node: ts.Expression;
  readonly type: ts.Type;
  readonly field?: string;
}
type Part = string | Binding;
interface Expansion {
  parts: Part[];
  choices: Map<Choice, boolean>;
}
export interface QueryVariant {
  readonly text: string;
  readonly parameters: readonly Binding[];
  readonly parameterTypes: readonly number[];
  readonly uncertainParameters: readonly number[];
}

export class Unsupported extends Error {
  constructor(
    readonly node: ts.Node,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    node = node.expression;
  return node;
}

function variable(
  checker: ts.TypeChecker,
  node: ts.Expression,
): ts.VariableDeclaration | undefined {
  const declaration = symbol(checker, node)?.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) ? declaration : undefined;
}

function constant(declaration: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    !!(declaration.parent.flags & ts.NodeFlags.Const)
  );
}

/** A bounded interpreter for SQL structure, never for application values or function bodies. */
export class SourceAnalysis {
  readonly issues: CheckDiagnostic[] = [];
  private readonly immutableArrays = new Set<ts.Symbol>();
  private readonly stableParameters = new Map<ts.Symbol, boolean>();
  private readonly unstableConditions = new Map<ts.Symbol, ts.ConditionalExpression>();
  constructor(
    readonly project: Project,
    private readonly libraries: ReadonlyMap<string, ts.Symbol>,
  ) {}

  role(input: ts.Expression, depth = 0): string | undefined {
    if (depth > 32) return undefined;
    const node = unwrap(input);
    const target = symbol(this.project.checker, node);
    for (const name of ['sql', 'unsafeSql', 'identifier']) {
      if (target && target === this.libraries.get(`@kequtech/tenon-orm:${name}`)) return name;
    }
    for (const name of ['param', 'json', 'builtin']) {
      if (
        target &&
        ['@kequtech/tenon-orm', '@kequtech/pgclear'].some(
          (module) => target === this.libraries.get(`${module}:${name}`),
        )
      )
        return `pgclear.${name}`;
    }
    if (ts.isPropertyAccessExpression(node) && this.role(node.expression, depth + 1) === 'sql')
      return `sql.${node.name.text}`;
    const declaration = variable(this.project.checker, node);
    return declaration?.initializer && constant(declaration)
      ? this.role(declaration.initializer, depth + 1)
      : undefined;
  }

  query(node: ts.Node): node is QueryNode {
    return (
      (ts.isTaggedTemplateExpression(node) && this.role(node.tag) === 'sql') ||
      (ts.isCallExpression(node) && this.role(node.expression) === 'unsafeSql')
    );
  }

  discover(source: ts.SourceFile): QueryNode[] {
    const queries: QueryNode[] = [];
    const visit = (node: ts.Node) => {
      if (this.query(node)) queries.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return queries;
  }

  private fail(node: ts.Node, code: string, message: string): never {
    throw new Unsupported(node, code, message);
  }

  private reference(node: ts.Expression, depth: number): ts.Expression {
    if (depth > 32)
      return this.fail(
        node,
        'composition-depth',
        'Composition exceeds the 32-reference depth limit.',
      );
    node = unwrap(node);
    const declaration = variable(this.project.checker, node);
    if (!declaration) return node;
    if (!constant(declaration) || !declaration.initializer) {
      return this.fail(
        node,
        'dynamic-binding',
        'SQL structure requires a const binding with a recoverable initializer.',
      );
    }
    return this.reference(declaration.initializer, depth + 1);
  }

  private text(input: ts.Expression): string {
    const node = this.reference(input, 0);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return this.fail(
      input,
      'dynamic-text',
      'SQL text, identifiers and separators require fixed string literals or const aliases.',
    );
  }

  private array(input: ts.Expression, depth = 0): readonly ts.Expression[] {
    if (depth > 32)
      return this.fail(input, 'composition-depth', 'Array composition exceeds the depth limit.');
    const node = unwrap(input);
    const declaration = variable(this.project.checker, node);
    if (declaration) {
      if (!constant(declaration) || !declaration.initializer)
        return this.fail(node, 'dynamic-array', 'A fixed array requires a const initializer.');
      const target = symbol(this.project.checker, node)!;
      if (!this.immutableArrays.has(target)) {
        this.closedReference(
          declaration,
          target,
          (parent) =>
            ['sql.join', 'sql.insertValues', 'sql.assignments', 'unsafeSql'].includes(
              this.role(parent.expression) ?? '',
            ),
          'mutable-array',
          'This array can be mutated or escape to application code; use a fixed array directly in the Tenon helper.',
        );
        this.immutableArrays.add(target);
      }
      return this.array(declaration.initializer, depth + 1);
    }
    if (!ts.isArrayLiteralExpression(node))
      return this.fail(
        input,
        'dynamic-array',
        'The checker requires a fixed array literal; runtime list lengths are unchecked.',
      );
    return node.elements.flatMap((element) => {
      if (ts.isSpreadElement(element)) return [...this.array(element.expression, depth + 1)];
      if (ts.isOmittedExpression(element))
        return this.fail(element, 'array-hole', 'Sparse expansion arrays are unsupported.');
      return [element];
    });
  }

  private closedReference(
    declaration: ts.VariableDeclaration,
    target: ts.Symbol,
    allowed: (call: ts.CallExpression, value: ts.Node) => boolean,
    code: string,
    message: string,
  ): void {
    for (const source of this.project.files) {
      const visit = (reference: ts.Node): void => {
        if (
          ts.isIdentifier(reference) &&
          reference !== declaration.name &&
          symbol(this.project.checker, reference) === target
        ) {
          let value: ts.Node = reference;
          while (
            ts.isParenthesizedExpression(value.parent) ||
            ts.isAsExpression(value.parent) ||
            ts.isSatisfiesExpression(value.parent)
          )
            value = value.parent;
          const parent = value.parent;
          const safe =
            ts.isCallExpression(parent) &&
            parent.arguments.includes(value as ts.Expression) &&
            allowed(parent, value);
          const exportedAlias = ts.isExportSpecifier(parent) || ts.isImportSpecifier(parent);
          if (!safe && !exportedAlias) this.fail(reference, code, message);
        }
        ts.forEachChild(reference, visit);
      };
      visit(source);
    }
  }

  private combine(
    left: readonly Expansion[],
    right: readonly Expansion[],
    at: ts.Node,
  ): Expansion[] {
    const result: Expansion[] = [];
    for (const a of left)
      for (const b of right) {
        if (
          [...a.choices].some(
            ([choice, selected]) => b.choices.has(choice) && b.choices.get(choice) !== selected,
          )
        )
          continue;
        result.push({
          parts: [...a.parts, ...b.parts],
          choices: new Map([...a.choices, ...b.choices]),
        });
        if (result.length > variantLimit)
          this.fail(at, 'variant-limit', `The query exceeds the ${variantLimit}-variant budget.`);
      }
    return result;
  }

  private conditional(node: ts.ConditionalExpression, depth: number): Expansion[] {
    let condition = unwrap(node.condition);
    let negated = false;
    while (
      ts.isPrefixUnaryExpression(condition) &&
      condition.operator === ts.SyntaxKind.ExclamationToken
    ) {
      negated = !negated;
      condition = unwrap(condition.operand);
    }
    const target = symbol(this.project.checker, condition);
    const declaration = variable(this.project.checker, condition);
    const valueDeclaration = target?.valueDeclaration;
    let stable = !!declaration && constant(declaration);
    if (target && valueDeclaration && ts.isParameter(valueDeclaration)) {
      if (!this.stableParameters.has(target)) {
        let written = false;
        const contains = (node: ts.Node): boolean =>
          (ts.isIdentifier(node) && symbol(this.project.checker, node) === target) ||
          !!ts.forEachChild(node, contains);
        const visit = (candidate: ts.Node): void => {
          if (
            ts.isBinaryExpression(candidate) &&
            candidate.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            candidate.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
            contains(candidate.left)
          )
            written = true;
          if (
            (ts.isPrefixUnaryExpression(candidate) || ts.isPostfixUnaryExpression(candidate)) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
              candidate.operator,
            ) &&
            contains(candidate.operand)
          )
            written = true;
          if (
            (ts.isForOfStatement(candidate) || ts.isForInStatement(candidate)) &&
            contains(candidate.initializer)
          )
            written = true;
          ts.forEachChild(candidate, visit);
        };
        visit(valueDeclaration.getSourceFile());
        this.stableParameters.set(target, !written);
      }
      stable = this.stableParameters.get(target)!;
    }
    if (target && !stable) {
      const previous = this.unstableConditions.get(target);
      if (previous && previous !== node)
        return this.fail(
          node,
          'branch-correlation-unresolved',
          'Several ternaries share a mutable condition; the checker cannot establish their complete variant set.',
        );
      this.unstableConditions.set(target, node);
    }
    const choice: Choice = target && stable ? target : node;
    const variants: Expansion[] = [];
    for (const [branch, selected] of [
      [node.whenTrue, true],
      [node.whenFalse, false],
    ] as const) {
      try {
        for (const expansion of this.expression(branch, depth + 1)) {
          const value = negated ? !selected : selected;
          if (expansion.choices.has(choice) && expansion.choices.get(choice) !== value) continue;
          variants.push({
            parts: expansion.parts,
            choices: new Map([...expansion.choices, [choice, value]]),
          });
        }
      } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        this.issues.push({
          ...location(error.node),
          kind: 'unchecked',
          code: error.code,
          message: error.message,
        });
      }
    }
    if (variants.length > variantLimit)
      this.fail(node, 'variant-limit', `The query exceeds the ${variantLimit}-variant budget.`);
    return variants;
  }

  private template(node: ts.TaggedTemplateExpression, depth: number): Expansion[] {
    if (ts.isNoSubstitutionTemplateLiteral(node.template))
      return [{ parts: [node.template.text], choices: new Map() }];
    let variants: Expansion[] = [{ parts: [node.template.head.text], choices: new Map() }];
    for (const span of node.template.templateSpans) {
      variants = this.combine(
        variants,
        this.expression(span.expression, depth + 1),
        span.expression,
      );
      for (const variant of variants) variant.parts.push(span.literal.text);
    }
    return variants;
  }

  private mutation(node: ts.CallExpression, helper: string): Expansion[] {
    const shapeNode = node.typeArguments?.[0];
    if (!shapeNode)
      return this.fail(
        node,
        'expansion-type-required',
        'Object expansion requires an explicit shape: sql.insertValues<Shape>(input) or sql.assignments<Shape>(input).',
      );
    const shape = this.project.checker.getTypeFromTypeNode(shapeNode);
    const open = (type: ts.Type): boolean =>
      !!(type.flags & ts.TypeFlags.TypeParameter) || !!type.aliasTypeArguments?.some(open);
    const unresolvedMapped =
      !!(shape.flags & ts.TypeFlags.Object) &&
      !!((shape as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) &&
      shape.getProperties().length === 0;
    if (
      shape.flags &
        (ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.TypeParameter |
          ts.TypeFlags.Union |
          ts.TypeFlags.Conditional |
          ts.TypeFlags.IndexedAccess) ||
      open(shape) ||
      unresolvedMapped ||
      shape.getStringIndexType() ||
      shape.getNumberIndexType() ||
      shape.getCallSignatures().length
    ) {
      return this.fail(
        shapeNode,
        'expansion-shape-unresolved',
        'Expansion requires one finite object shape, without any, unions, open generics or index signatures.',
      );
    }
    const input = node.arguments[0];
    if (!input)
      return this.fail(node, 'expansion-input-required', 'Object expansion requires an input.');
    if (!node.arguments[1])
      this.issues.push({
        ...location(node),
        kind: 'unproven',
        code: 'expansion-shape-assumed',
        message:
          'The explicit shape is trusted to describe exactly the expanded own fields and their order. An explicit column list removes that assumption.',
      });
    const columns = node.arguments[1]
      ? this.array(node.arguments[1]).map((key) => this.text(key))
      : shape.getProperties().map((property) => property.name);
    if (node.arguments[1] && !columns.length)
      return this.fail(node, 'expansion-columns', 'An explicit column list must be nonempty.');
    if (new Set(columns).size !== columns.length)
      return this.fail(node, 'expansion-columns', 'Expansion column names must be unique.');
    for (const name of columns) {
      try {
        quote(name);
      } catch {
        return this.fail(
          node,
          'expansion-columns',
          'Expansion columns must be valid PostgreSQL identifiers.',
        );
      }
    }
    const fields = columns.map((name) => {
      const property = shape.getProperty(name);
      if (!property)
        return this.fail(
          node,
          'expansion-columns',
          `Column ${name} is absent from the expansion shape.`,
        );
      const type = this.project.checker.getTypeOfSymbolAtLocation(property, shapeNode);
      if (property.flags & ts.SymbolFlags.Optional || this.containsUndefined(type)) {
        return this.fail(
          shapeNode,
          'optional-expansion',
          `Expansion field ${name} may be absent or undefined, changing the SQL. Select required, defined fields for checking.`,
        );
      }
      return { name, binding: { node: input, type, field: name } satisfies Binding };
    });
    const parts: Part[] = [];
    if (helper === 'sql.assignments') {
      if (!fields.length)
        return this.fail(node, 'empty-expansion', 'An assignment needs at least one field.');
      for (const [index, field] of fields.entries()) {
        if (index) parts.push(', ');
        parts.push(`${quote(field.name)} = `, field.binding);
      }
    } else {
      const inputType = this.project.checker.getTypeAtLocation(input);
      const rows =
        this.project.checker.isArrayType(inputType) || this.project.checker.isTupleType(inputType)
          ? this.array(input)
          : [input];
      if (!rows.length || (!fields.length && rows.length > 1))
        return this.fail(
          node,
          'empty-expansion',
          'Expansion requires a nonempty batch; a default-only insert requires one row.',
        );
      if (!fields.length) parts.push('DEFAULT VALUES');
      else {
        parts.push(`(${columns.map(quote).join(', ')}) VALUES `);
        for (const [index, row] of rows.entries()) {
          if (index) parts.push(', ');
          parts.push('(');
          for (const [position, field] of fields.entries()) {
            if (position) parts.push(', ');
            parts.push({ ...field.binding, node: row });
          }
          parts.push(')');
        }
      }
    }
    return [{ parts, choices: new Map() }];
  }

  private containsUndefined(type: ts.Type): boolean {
    return (
      !!(type.flags & ts.TypeFlags.Undefined) ||
      (!!type.isUnion() && type.types.some((part) => this.containsUndefined(part)))
    );
  }

  private expression(input: ts.Expression, depth: number): Expansion[] {
    if (depth > 32)
      return this.fail(
        input,
        'composition-depth',
        'Composition exceeds the 32-reference depth limit.',
      );
    const node = unwrap(input);
    if (ts.isConditionalExpression(node)) return this.conditional(node, depth);
    if (ts.isTaggedTemplateExpression(node)) {
      if (this.role(node.tag) === 'sql.fragment') {
        const variants = this.template(node, depth);
        if (
          variants.some(
            ({ parts }) => !parts.some((part) => typeof part !== 'string' || part.trim()),
          )
        )
          return this.fail(node, 'empty-fragment', 'SQL fragments must not be empty.');
        return variants;
      }
      if (this.role(node.tag) === 'sql')
        return this.fail(
          node,
          'nested-query',
          'Executable SQL queries cannot be nested; use sql.fragment.',
        );
    }
    if (ts.isCallExpression(node)) {
      const role = this.role(node.expression);
      if (role === 'identifier') {
        if (!node.arguments.length)
          return this.fail(node, 'invalid-identifier', 'An identifier requires at least one name.');
        const names = node.arguments.map((argument) => this.text(argument));
        try {
          return [{ parts: [names.map(quote).join('.')], choices: new Map() }];
        } catch {
          return this.fail(
            node,
            'invalid-identifier',
            'Identifier names must contain 1–63 UTF-8 bytes and no NUL.',
          );
        }
      }
      if (role === 'sql.insertValues' || role === 'sql.assignments')
        return this.mutation(node, role);
      if (role === 'sql.join') {
        if (!node.arguments[0] || !node.arguments[1])
          return this.fail(node, 'join-arguments', 'sql.join requires a fixed list and separator.');
        const selected = this.text(node.arguments[1]);
        if (!['AND', 'OR', ','].includes(selected))
          return this.fail(node, 'invalid-separator', 'sql.join separators are AND, OR, or comma.');
        const separator = joinSeparator(selected);
        const fragments = this.array(node.arguments[0]);
        if (!fragments.length)
          return this.fail(node, 'empty-join', 'sql.join requires a nonempty list.');
        let variants: Expansion[] = [{ parts: [], choices: new Map() }];
        for (const [index, fragment] of fragments.entries()) {
          const type = this.project.checker.getTypeAtLocation(fragment);
          if (
            !(type.isUnion() ? type.types : [type]).every((part) =>
              part.getProperty('__tenonFragment'),
            )
          )
            return this.fail(
              fragment,
              'join-fragment-unresolved',
              'sql.join requires recoverable SqlFragment values.',
            );
          if (index) for (const variant of variants) variant.parts.push(separator);
          variants = this.combine(variants, this.expression(fragment, depth + 1), fragment);
        }
        return variants;
      }
    }
    const type = this.project.checker.getTypeAtLocation(input);
    const members = type.isUnion() ? type.types : [type];
    if (
      members.some((member) => member.getProperty('__tenonFragment') || member.getProperty('names'))
    ) {
      const resolved = this.reference(node, depth);
      if (resolved === node)
        return this.fail(
          node,
          'dynamic-fragment',
          'The fragment or identifier has no recoverable source initializer; arbitrary function calls and mutable composition are unchecked.',
        );
      return this.expression(resolved, depth + 1);
    }
    return [{ parts: [{ node: input, type }], choices: new Map() }];
  }

  private codecOid(input: ts.Expression): number | undefined {
    const declaration = variable(this.project.checker, unwrap(input));
    if (declaration)
      this.closedReference(
        declaration,
        symbol(this.project.checker, unwrap(input))!,
        (call, value) =>
          this.role(call.expression) === 'pgclear.param' && call.arguments[1] === value,
        'mutable-codec',
        'The codec can be mutated or escape; its parameter OID is unresolved.',
      );
    let node: ts.Expression;
    try {
      node = this.reference(input, 0);
    } catch (error) {
      if (error instanceof Unsupported) return undefined;
      throw error;
    }
    if (ts.isPropertyAccessExpression(node) && this.role(node.expression) === 'pgclear.builtin') {
      const codec = builtin[node.name.text as keyof typeof builtin];
      return codec?.oid;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const property = node.properties.find(
        (property) => ts.isPropertyAssignment(property) && property.name.getText() === 'oid',
      );
      if (property && ts.isPropertyAssignment(property)) {
        const type = this.project.checker.getTypeAtLocation(property.initializer);
        if (type.isNumberLiteral()) return type.value;
      }
    }
    return undefined;
  }

  private encoderOid(input: ts.Expression): number | undefined {
    let node: ts.Expression;
    try {
      node = this.reference(input, 0);
    } catch (error) {
      if (error instanceof Unsupported) return undefined;
      throw error;
    }
    if (!ts.isCallExpression(node)) return undefined;
    if (this.role(node.expression) === 'pgclear.json') {
      const type = node.arguments[1] ? this.text(node.arguments[1]) : 'jsonb';
      return type === 'json' || type === 'jsonb' ? builtin[type].oid : undefined;
    }
    if (this.role(node.expression) === 'pgclear.param' && node.arguments[1])
      return this.codecOid(node.arguments[1]);
    return undefined;
  }

  private hints(
    binding: Binding,
    parameter: number,
  ): { oids: readonly number[]; uncertain: boolean } {
    const checker = this.project.checker;
    const hints = new Set<number>();
    let uncertain = false;
    const visit = (type: ts.Type): void => {
      if (type.isUnion()) {
        type.types.forEach(visit);
        return;
      }
      if (type.flags & ts.TypeFlags.TypeParameter) {
        const constraint = checker.getBaseConstraintOfType(type);
        if (constraint && constraint !== type) {
          visit(constraint);
          return;
        }
      }
      if (
        type.flags &
        (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.TypeParameter)
      ) {
        return this.fail(
          binding.node,
          'parameter-type-unresolved',
          `Parameter ${binding.field ?? ''} has an unresolved input type (${checker.typeToString(type)}).`,
        );
      }
      if (
        type.isNumberLiteral() &&
        (!Number.isFinite(type.value) ||
          (Number.isInteger(type.value) && !Number.isSafeInteger(type.value)))
      ) {
        this.issues.push({
          ...location(binding.node),
          kind: 'mismatch',
          code: 'parameter-value-mismatch',
          parameter,
          expected: 'finite number, with safe integer values',
          observed: String(type.value),
          message: `Parameter ${parameter} is a numeric literal pgclear rejects.`,
        });
      }
      if (
        type.flags & ts.TypeFlags.Null ||
        checker.isTypeAssignableTo(type, this.project.types.get('string')!) ||
        checker.isTypeAssignableTo(type, this.project.types.get('number')!) ||
        checker.isTypeAssignableTo(type, this.project.types.get('bigint')!) ||
        checker.isTypeAssignableTo(type, this.project.types.get('globalThis.Date')!) ||
        checker.isTypeAssignableTo(
          type,
          this.project.types.get('import("@kequtech/tenon-orm").TemporalInput')!,
        )
      ) {
        hints.add(0);
        return;
      }
      if (checker.isTypeAssignableTo(type, this.project.types.get('boolean')!)) {
        hints.add(builtin.bool.oid);
        return;
      }
      if (checker.isTypeAssignableTo(type, this.project.types.get('globalThis.Uint8Array')!)) {
        hints.add(builtin.bytea.oid);
        return;
      }
      if (checker.isTypeAssignableTo(type, this.project.parameterType)) {
        let oid: number | undefined;
        try {
          oid = binding.field === undefined ? this.encoderOid(binding.node) : undefined;
        } catch (error) {
          if (!(error instanceof Unsupported)) throw error;
        }
        if (oid !== undefined && Number.isInteger(oid) && oid > 0 && oid <= 0xffffffff) {
          hints.add(oid);
          return;
        }
        if (oid !== undefined) {
          this.issues.push({
            ...location(binding.node),
            kind: 'mismatch',
            code: 'encoder-oid-invalid',
            parameter,
            message: `The encoder declares invalid PostgreSQL OID ${oid}.`,
          });
        } else {
          uncertain = true;
          this.issues.push({
            ...location(binding.node),
            kind: 'unproven',
            code: 'encoder-oid-unproven',
            parameter,
            message: `Input ${binding.field ?? parameter} is declared as a pgclear Parameter, but its encoder OID is unknown. Describe uses server inference; parameter and dependent result contracts remain unproven.`,
          });
        }
        hints.add(0);
        return;
      }
      this.issues.push({
        ...location(binding.node),
        kind: 'mismatch',
        code: 'parameter-type-mismatch',
        parameter,
        message: `Input ${binding.field ?? 'parameter'} of type ${checker.typeToString(type)} is not a plain pgclear bind. Use null, a scalar, Date, Temporal, Uint8Array or an explicit encoder.`,
        expected: 'pgclear InputValue',
        observed: checker.typeToString(type),
      });
      hints.add(0);
    };
    visit(binding.type);
    return { oids: [...hints], uncertain };
  }

  recover(node: QueryNode): QueryVariant[] {
    let expansions: Expansion[];
    try {
      if (ts.isTaggedTemplateExpression(node)) expansions = this.template(node, 0);
      else {
        if (!node.arguments[0] || !node.arguments[1])
          return this.fail(
            node,
            'unsafe-sql-input',
            'unsafeSql requires fixed SQL and a fixed values array.',
          );
        // Raw SQL already contains its own placeholders; these parts are not template interpolations.
        const text = this.text(node.arguments[0]);
        const bindings = this.array(node.arguments[1]).map((value) => ({
          node: value,
          type: this.project.checker.getTypeAtLocation(value),
        }));
        return this.withHints(text, bindings, node);
      }
      const variants: QueryVariant[] = [];
      for (const expansion of expansions) {
        const bindings: Binding[] = [];
        const text = expansion.parts
          .map((part) => {
            if (typeof part === 'string') return part;
            bindings.push(part);
            return `$${bindings.length}`;
          })
          .join('');
        variants.push(...this.withHints(text, bindings, node));
        if (variants.length > variantLimit)
          this.fail(node, 'variant-limit', `The query exceeds the ${variantLimit}-variant budget.`);
      }
      return variants;
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      this.issues.push({
        ...location(error.node),
        kind: 'unchecked',
        code: error.code,
        message: error.message,
      });
      return [];
    }
  }

  private withHints(text: string, bindings: Binding[], node: ts.Node): QueryVariant[] {
    if (!text.trim()) this.fail(node, 'empty-query', 'SQL queries must not be empty.');
    if (bindings.length > 65535)
      this.fail(node, 'parameter-limit', "The query exceeds PostgreSQL's 65,535-parameter limit.");
    let lists: number[][] = [[]];
    const uncertainParameters: number[] = [];
    for (const [index, binding] of bindings.entries()) {
      const hints = this.hints(binding, index + 1);
      if (hints.uncertain) uncertainParameters.push(index + 1);
      if (hints.oids.length === 1) for (const list of lists) list.push(hints.oids[0]!);
      else lists = lists.flatMap((list) => hints.oids.map((oid) => [...list, oid]));
      if (lists.length > variantLimit)
        this.fail(
          node,
          'variant-limit',
          `Parameter type alternatives exceed the ${variantLimit}-variant budget.`,
        );
    }
    return lists.map((parameterTypes) => ({
      text,
      parameters: bindings,
      parameterTypes,
      uncertainParameters,
    }));
  }
}

export type { QueryNode };
