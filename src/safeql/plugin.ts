import type { SafeQLPlugin } from '@ts-safeql/plugin-utils';
import ts from 'typescript';
import {
  isExport,
  isFragment,
  isIdentifierType,
  renderFragment,
  renderIdentifier,
} from './composition.js';

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
        return {};
      }
      return undefined;
    },
    onExpression({ context }) {
      if (isFragment(context.tsType)) return renderFragment(context.tsNode, context.checker);
      if (isIdentifierType(context.tsType))
        return renderIdentifier(context.tsNode, context.checker);
      return undefined;
    },
  };
}
