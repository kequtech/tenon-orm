import type { SafeQLPlugin } from '@ts-safeql/plugin-utils';
import ts from 'typescript';
import { CompositionError, isExport, renderValue } from './composition.js';

/** Loaded by SafeQL from the preset; not a public runtime entry point. */
export function factory(): SafeQLPlugin {
  return {
    name: 'tenon',
    onTarget({ node, context }) {
      const template = context.parser.esTreeNodeToTSNodeMap.get(node);
      if (
        ts.isTaggedTemplateExpression(template) &&
        isExport(template.tag, context.checker, 'sql')
      ) {
        // SafeQL reads raw quasis; Tenon executes their JavaScript-decoded text.
        if (node.quasi.quasis.some(({ value }) => value.raw !== value.cooked)) {
          throw new CompositionError(
            'JavaScript escapes in an outer sql template would be checked as different SQL. Use literal newlines and bound string values instead.',
          );
        }
        return {};
      }
      return undefined;
    },
    onExpression({ context }) {
      return renderValue(context.tsNode, context.checker);
    },
  };
}
