import type { SafeQLPlugin } from '@ts-safeql/plugin-utils';
import ts from 'typescript';
import { CompositionError, isExport, renderValue } from './composition.js';

/** Loaded through the exported SafeQL plugin descriptor. */
export function factory(): SafeQLPlugin {
  return {
    name: 'tenon',
    connectionDefaults: {
      inferLiterals: false,
      overrides: {
        types: {
          int8: 'string',
          numeric: 'string',
          json: 'unknown',
          jsonb: 'unknown',
          date: 'Date | number',
          timestamp: 'Date | number',
          timestamptz: 'Date | number',
        },
      },
    },
    onTarget({ node, context }) {
      const template = context.parser.esTreeNodeToTSNodeMap.get(node);
      if (
        !ts.isTaggedTemplateExpression(template) ||
        !isExport(template.tag, context.checker, 'sql')
      )
        return false;
      // The companion ESLint rule reports unsupported forms. Skip their SQL analysis.
      if (node.quasi.quasis.some(({ value }) => value.raw !== value.cooked)) return false;
      // Defer to SafeQL's configured targets, including per-connection tag selection.
      return undefined;
    },
    onExpression({ context }) {
      try {
        return renderValue(context.tsNode, context.checker);
      } catch (error) {
        if (!(error instanceof CompositionError)) throw error;
        return false;
      }
    },
  };
}
