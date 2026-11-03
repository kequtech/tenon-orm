import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import * as ts from './compiler.js';
import { checkerConfig, findConfig } from './config.js';
import { defaultCodecs } from '@kequtech/pgclear';
import type { CheckOptions, CheckDiagnostic, SourceLocation } from './types.js';

export function location(node: ts.Node): SourceLocation {
  const source = node.getSourceFile();
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return {
    file: resolve(source.fileName),
    line: position.line + 1,
    column: position.character + 1,
  };
}

export function symbol(checker: ts.Checker, node: ts.Node): ts.Symbol | undefined {
  const found =
    node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
  return found && found.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found;
}

/** Validate modules supplying representation types without selecting unrelated project files. */
function representationSources(checker: ts.Checker, root: ts.SourceFile): ts.SourceFile[] {
  const sources = new Set<ts.SourceFile>();
  const pending = [root];
  while (pending.length) {
    const source = pending.pop()!;
    if (sources.has(source)) continue;
    sources.add(source);
    const visit = (node: ts.Node): void => {
      let reference: ts.Node | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        reference = node.moduleSpecifier;
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        reference = node.argument.literal;
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        reference = node.moduleReference.expression;
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        reference = node.arguments[0];
      }
      if (reference && ts.isStringLiteralLikeNode(reference)) {
        const module = checker.getSymbolAtLocation(reference);
        for (const declaration of module?.declarations ?? []) {
          const node = declaration.resolve();
          if (node) pending.push(node.getSourceFile());
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  return [...sources];
}

const representations = [
  'unknown',
  'string',
  'number',
  'bigint',
  'boolean',
  'globalThis.Uint8Array',
  'globalThis.Date',
  'import("@kequtech/tenon-orm").TemporalInput',
  ...['unknown', 'string', 'number', 'bigint', 'boolean', 'globalThis.Uint8Array'].map(
    (type) => `PgArray<${type}>`,
  ),
];

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return [diagnostic.text, ...(diagnostic.messageChain ?? []).map(diagnosticText)].join('\n');
}

export interface Project {
  readonly program: ts.Program;
  readonly checker: ts.Checker;
  readonly types: ReadonlyMap<string, ts.Type>;
  readonly parameterType: ts.Type;
  readonly files: readonly ts.SourceFile[];
  readonly selected: readonly ts.SourceFile[];
  readonly line: number | undefined;
  readonly project: string;
  readonly diagnostics: CheckDiagnostic[];
  addTypes(expressions: readonly string[]): void;
  [Symbol.dispose](): void;
}

export function loadProject(options: CheckOptions): Project {
  const match = options.target?.match(/^(.*):(\d+)$/);
  const filename = options.target === undefined ? undefined : resolve(match?.[1] ?? options.target);
  const line = match === null || match === undefined ? undefined : Number(match[2]);
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1))
    throw new Error('The query line must be a positive, one-based integer.');
  const configPath = findConfig(options.project, filename ? dirname(filename) : process.cwd());
  const custom = Object.entries(options.readTypes ?? {});
  for (const [oid, type] of custom) {
    if (
      !Number.isInteger(Number(oid)) ||
      Number(oid) < 1 ||
      Number(oid) > 0xffffffff ||
      typeof type !== 'string' ||
      !type.trim()
    )
      throw new Error(
        'readTypes requires PostgreSQL OIDs and nonempty TypeScript type expressions.',
      );
  }
  const expressions = [
    ...new Set([
      ...representations,
      ...(options.codecs ?? defaultCodecs).typescriptTypes(),
      ...custom.map(([, type]) => type),
    ]),
  ];
  const id = randomUUID();
  const virtualPath = resolve(dirname(configPath), `.tenon-check-${id}.ts`);
  const virtualConfig = resolve(dirname(configPath), `.tenon-check-${id}.json`);
  const virtualFiles = new Map([[virtualConfig, checkerConfig(configPath, virtualPath)]]);
  const api = new ts.API({
    fs: {
      readFile: (file) => virtualFiles.get(resolve(file)),
      fileExists: (file) => (virtualFiles.has(resolve(file)) ? true : undefined),
    },
  });
  try {
    const writeTypes = () =>
      virtualFiles.set(
        virtualPath,
        [
          'type PgArray<T> = readonly (T | null | PgArray<T>)[];',
          ...expressions.map((type, index) => `export type Read${index} = ${type};`),
          'export type Parameter = import("@kequtech/tenon-orm").Parameter;',
        ].join('\n'),
      );
    writeTypes();
    let snapshot = api.updateSnapshot({ openProjects: [virtualConfig] });
    const initial = snapshot.getProject(virtualConfig);
    if (!initial) throw new Error('The native TypeScript compiler could not load the project.');
    let native = initial;
    const types = new Map<string, ts.Type>();
    const resolveTypes = (native: ts.Project) => {
      const helper = native.program.getSourceFile(virtualPath);
      if (!helper) throw new Error('The native TypeScript compiler could not load checker types.');
      const helperErrors = representationSources(native.checker, helper).flatMap((source) => [
        ...native.program.getSyntacticDiagnostics(source.fileName),
        ...native.program.getSemanticDiagnostics(source.fileName),
      ]);
      if (helperErrors.length)
        throw new Error(
          `Cannot resolve checker representation types: ${helperErrors.map(diagnosticText).join('\n')}`,
        );
      types.clear();
      let parameterType: ts.Type | undefined;
      for (const statement of helper.statements) {
        if (!ts.isTypeAliasDeclaration(statement)) continue;
        const type = native.checker.getTypeFromTypeNode(statement.type);
        if (!type)
          throw new Error(`Cannot resolve checker representation type ${statement.name.text}.`);
        if (statement.name.text === 'Parameter') parameterType = type;
        else types.set(expressions[Number(statement.name.text.slice(4))]!, type);
      }
      if (!parameterType) throw new Error('Cannot resolve checker Parameter type.');
      return parameterType;
    };
    let parameterType = resolveTypes(native);
    const program = native.program;
    const files = program.getSourceFileNames().flatMap((file) => {
      const source = program.getSourceFile(file);
      return source &&
        !source.isDeclarationFile &&
        resolve(file) !== virtualPath &&
        !program.isSourceFileFromExternalLibrary(source)
        ? [source]
        : [];
    });
    const selected =
      filename === undefined
        ? files
        : files.filter((source) => resolve(source.fileName) === filename);
    if (filename !== undefined && !selected.length)
      throw new Error(
        'The target file is not a source file in this TypeScript project. Check --project and tsconfig inclusion.',
      );
    const diagnostics: CheckDiagnostic[] = [];
    for (const error of [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(),
    ]) {
      if (error.category === ts.DiagnosticCategory.Error)
        diagnostics.push({
          file: configPath,
          line: 1,
          column: 1,
          kind: 'mismatch',
          code: 'typescript-configuration',
          message: diagnosticText(error),
        });
    }
    for (const source of selected) {
      for (const error of [
        ...program.getSyntacticDiagnostics(source.fileName),
        ...program.getSemanticDiagnostics(source.fileName),
      ]) {
        if (error.category !== ts.DiagnosticCategory.Error) continue;
        const position = source.getLineAndCharacterOfPosition(Math.max(0, error.pos));
        diagnostics.push({
          file: resolve(source.fileName),
          line: position.line + 1,
          column: position.character + 1,
          kind: 'mismatch',
          code: 'typescript-error',
          message: diagnosticText(error),
        });
      }
    }
    return {
      get program() {
        return native.program;
      },
      get checker() {
        return native.checker;
      },
      types,
      get parameterType() {
        return parameterType;
      },
      files,
      selected,
      line,
      project: configPath,
      diagnostics,
      addTypes(additional) {
        const missing = [...new Set(additional)].filter((type) => !types.has(type));
        if (!missing.length) return;
        expressions.push(...missing);
        writeTypes();
        const previous = snapshot;
        snapshot = api.updateSnapshot({ fileChanges: { changed: [virtualPath] } });
        const updated = snapshot.getProject(virtualConfig);
        if (!updated) throw new Error('The native TypeScript compiler lost the checker project.');
        native = updated;
        try {
          parameterType = resolveTypes(native);
        } finally {
          previous.dispose();
        }
      },
      [Symbol.dispose]() {
        api.close();
      },
    };
  } catch (error) {
    api.close();
    throw error;
  }
}

/** Resolve actual exported symbols, including aliases and barrel re-exports. */
export function librarySymbols(project: Project): ReadonlyMap<string, ts.Symbol> {
  const found = new Map<string, ts.Symbol>();
  for (const file of project.program.getSourceFileNames()) {
    const source = project.program.getSourceFile(file)!;
    for (const statement of source.statements) {
      if (
        !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const moduleName = statement.moduleSpecifier.text;
      if (!['@kequtech/tenon-orm', '@kequtech/pgclear'].includes(moduleName)) continue;
      const module = project.checker.getSymbolAtLocation(statement.moduleSpecifier);
      if (!module) continue;
      for (const exported of project.checker.getExportsOfModule(module)) {
        const target =
          exported.flags & ts.SymbolFlags.Alias
            ? project.checker.getAliasedSymbol(exported)
            : exported;
        found.set(`${moduleName}:${exported.name}`, target);
      }
    }
  }
  return found;
}
