import type { ESLint, Rule } from 'eslint';
import ts from 'typescript';
import { CompositionError, isExport, renderValue } from './composition.js';

export const eslintPlugin: ESLint.Plugin = {
  rules: {
    'check-composition': {
      meta: {
        type: 'problem',
        docs: { description: 'Report Tenon queries that cannot be statically checked.' },
        schema: [],
      },
      create(context: Rule.RuleContext): Rule.RuleListener {
        // ESLint leaves parser services untyped; require the TypeScript parser's public services.
        const { program, esTreeNodeToTSNodeMap: nodes } = context.sourceCode.parserServices as {
          program?: ts.Program;
          esTreeNodeToTSNodeMap?: ReadonlyMap<object, ts.Node>;
        };
        if (!program || !nodes) {
          throw new Error(
            'tenon/check-composition requires type-aware TypeScript parsing. Enable parserOptions.project or projectService.',
          );
        }
        const checker = program.getTypeChecker();
        return {
          TaggedTemplateExpression(node) {
            const template = nodes.get(node);
            if (
              !template ||
              !ts.isTaggedTemplateExpression(template) ||
              !isExport(template.tag, checker, 'sql')
            )
              return;
            if (node.quasi.quasis.some(({ value }) => value.raw !== value.cooked)) {
              context.report({
                node,
                message: new CompositionError(
                  'JavaScript escapes in an outer sql template would be checked as different SQL. Use literal newlines and bound string values instead.',
                ).message,
              });
              return;
            }
            if (ts.isTemplateExpression(template.template)) {
              for (const [index, span] of template.template.templateSpans.entries()) {
                try {
                  renderValue(span.expression, checker);
                } catch (error) {
                  if (!(error instanceof CompositionError)) throw error;
                  context.report({ node: node.quasi.expressions[index]!, message: error.message });
                  return;
                }
              }
            }
          },
        };
      },
    },
  },
};
