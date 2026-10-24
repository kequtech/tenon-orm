import ts from 'typescript';
import { assignmentLayout, insertLayout, mutationColumns } from '../mutations.js';
import { CompositionError, isUndefined, literalString, unwrap } from './static.js';

type Fields = ReadonlyMap<string, ts.Node>;
const parameter = 0;

function fields(input: ts.Node): Fields {
  const node = unwrap(input);
  if (!ts.isObjectLiteralExpression(node)) {
    throw new CompositionError(
      'Mutation inputs need inline object literals or an explicit literal column list.',
    );
  }
  const result = new Map<string, ts.Node>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      throw new CompositionError(
        'Mutation object spreads, accessors, and methods need an explicit literal column list.',
      );
    }
    const name = property.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) {
      throw new CompositionError(
        'Mutation keys must be literal names; use an explicit literal column list.',
      );
    }
    if (name.text === '__proto__')
      throw new CompositionError(
        'Prototype-setting object literals are unsupported mutation inputs.',
      );
    if (result.has(name.text))
      throw new CompositionError('Duplicate mutation object keys are unsupported.');
    result.set(name.text, ts.isPropertyAssignment(property) ? property.initializer : property.name);
  }
  return result;
}

/** Understand the official mutation contract, never the implementation of a JavaScript helper. */
export function renderMutation(
  kind: 'insertValues' | 'assignments',
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): string {
  if (
    node.questionDotToken ||
    node.arguments.some(ts.isSpreadElement) ||
    node.arguments.length < 1 ||
    node.arguments.length > 2
  ) {
    throw new CompositionError(
      `sql.${kind} requires an input and an optional literal column list.`,
    );
  }
  try {
    const [argument, selected] = node.arguments;
    let columns: readonly string[];
    let rows: readonly (readonly unknown[])[];
    if (selected && !isUndefined(selected, checker)) {
      const list = unwrap(selected);
      if (!ts.isArrayLiteralExpression(list))
        throw new CompositionError('Mutation columns must be an inline literal array.');
      columns = mutationColumns(
        list.elements.map((item) => {
          const column = literalString(item, checker);
          if (column === undefined)
            throw new CompositionError(
              'Mutation columns must be literal strings or const strings.',
            );
          return column;
        }),
      );
      // A fixed column contract covers any nonempty batch and every omitted/default cell.
      // Check all selected columns conservatively; no runtime data or JS types become SQL.
      rows = [columns.map(() => parameter)];
    } else {
      const value = unwrap(argument!);
      const objects =
        kind === 'insertValues' && ts.isArrayLiteralExpression(value)
          ? value.elements.map(fields)
          : [fields(value)];
      columns = [
        ...new Set(
          objects.flatMap((row) =>
            [...row].filter(([, value]) => !isUndefined(value, checker)).map(([key]) => key),
          ),
        ),
      ];
      rows = objects.map((row) =>
        columns.map((column) => {
          const cell = row.get(column);
          return !cell || isUndefined(cell, checker) ? undefined : parameter;
        }),
      );
    }
    const parts =
      kind === 'insertValues' ? insertLayout(columns, rows) : assignmentLayout(columns, rows[0]!);
    return parts.map((part) => (typeof part === 'string' ? part : '$N')).join('');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new CompositionError(
      `sql.${kind}: ${error instanceof CompositionError ? error.detail : error.message}`,
    );
  }
}
