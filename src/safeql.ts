import safeql from '@ts-safeql/eslint-plugin/config';
import { rules } from '@ts-safeql/eslint-plugin';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import type { FlatConfig } from 'typescript-eslint';

type ConnectionOptions = Exclude<Parameters<typeof safeql.configs.connections>[0], unknown[]>;

export interface TenonSafeqlOptions {
  /** The application's development/test database, at its current migration checkpoint. */
  readonly databaseUrl: string;
  readonly files?: string[];
  readonly project?: string;
  readonly tsconfigRootDir?: string;
  /** Application-owned parser and column mappings override the standard pg defaults. */
  readonly overrides?: ConnectionOptions['overrides'];
}

/** Optional development tooling. Never imported by Tenon's runtime entry point. */
export function tenonSafeql(options: TenonSafeqlOptions): FlatConfig.Config[] {
  if (typeof options.databaseUrl !== 'string' || !options.databaseUrl.trim()) {
    throw new Error('tenonSafeql requires an explicit development/test databaseUrl.');
  }
  const config = safeql.configs.connections({
    databaseUrl: options.databaseUrl,
    keepAlive: false,
    inferLiterals: false,
    plugins: [{ package: fileURLToPath(new URL('./safeql/plugin.js', import.meta.url)) }],
    overrides: {
      ...options.overrides,
      types: {
        int8: 'string',
        numeric: 'string',
        json: 'unknown',
        jsonb: 'unknown',
        date: 'Date | number',
        timestamp: 'Date | number',
        timestamptz: 'Date | number',
        ...options.overrides?.types,
      },
    },
  });
  const rule = rules['check-sql'];
  return [
    {
      ...config,
      plugins: {
        '@ts-safeql': {
          rules: {
            'check-sql': {
              ...rule,
              create(context) {
                const listeners = rule.create(context);
                return {
                  ...listeners,
                  TaggedTemplateExpression(
                    node: Parameters<NonNullable<typeof listeners.TaggedTemplateExpression>>[0],
                  ) {
                    try {
                      listeners.TaggedTemplateExpression?.(node);
                    } catch (error) {
                      if (!(error instanceof Error) || error.name !== 'TenonCompositionError')
                        throw error;
                      context.report({
                        node,
                        messageId: 'pluginError',
                        data: { error: error.message },
                      });
                    }
                  },
                };
              },
            },
          },
        },
      },
      files: options.files ?? ['src/**/*.ts'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          project: options.project ?? './tsconfig.json',
          ...(options.tsconfigRootDir && { tsconfigRootDir: options.tsconfigRootDir }),
        },
      },
    },
  ];
}
