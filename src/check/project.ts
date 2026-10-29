import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
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

export function symbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const found =
    node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
  return found && found.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found;
}

const representations = [
  'unknown',
  'string',
  'number',
  'bigint',
  'boolean',
  'globalThis.Uint8Array',
  ...['unknown', 'string', 'number', 'bigint', 'boolean', 'globalThis.Uint8Array'].map(
    (type) => `PgArray<${type}>`,
  ),
];

export function loadProject(options: CheckOptions) {
  const match = options.target?.match(/^(.*):(\d+)$/);
  const filename = options.target === undefined ? undefined : resolve(match?.[1] ?? options.target);
  const line = match === null || match === undefined ? undefined : Number(match[2]);
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) {
    throw new Error('The query line must be a positive, one-based integer.');
  }
  const configPath =
    options.project === undefined
      ? ts.findConfigFile(filename ? dirname(filename) : process.cwd(), ts.sys.fileExists)
      : ts.sys.directoryExists(resolve(options.project))
        ? resolve(options.project, 'tsconfig.json')
        : resolve(options.project);
  if (!configPath)
    throw new Error('No tsconfig.json found. Pass --project with the project configuration.');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  }
  if (!(parsed.options.strictNullChecks ?? parsed.options.strict)) {
    throw new Error('Query checking requires strictNullChecks in the TypeScript project.');
  }
  const custom = Object.entries(options.readTypes ?? {});
  for (const [oid, type] of custom) {
    if (
      !Number.isInteger(Number(oid)) ||
      Number(oid) < 1 ||
      Number(oid) > 0xffffffff ||
      typeof type !== 'string' ||
      !type.trim()
    ) {
      throw new Error(
        'readTypes requires PostgreSQL OIDs and nonempty TypeScript type expressions.',
      );
    }
  }
  const expressions = [...new Set([...representations, ...custom.map(([, type]) => type)])];
  const virtualPath = resolve(dirname(configPath), `.tenon-check-${randomUUID()}.ts`);
  const virtualSource = [
    'type PgArray<T> = readonly (T | null | PgArray<T>)[];',
    ...expressions.map((type, index) => `export type Read${index} = ${type};`),
    'export type Parameter = import("@kequtech/pgclear").Parameter;',
  ].join('\n');
  // Emission layout must not constrain the in-memory representation module.
  const compilerOptions = { ...parsed.options, noEmit: true };
  delete compilerOptions.rootDir;
  const host = ts.createCompilerHost(compilerOptions);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (path) => (resolve(path) === virtualPath ? virtualSource : readFile(path));
  host.fileExists = (path) => resolve(path) === virtualPath || fileExists(path);
  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, virtualPath],
    options: compilerOptions,
    host,
    ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
  });
  const checker = program.getTypeChecker();
  const helper = program.getSourceFile(virtualPath)!;
  const types = new Map<string, ts.Type>();
  for (const statement of helper.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text.startsWith('Read')) {
      types.set(
        expressions[Number(statement.name.text.slice(4))]!,
        checker.getTypeFromTypeNode(statement.type),
      );
    }
  }
  const parameterNode = helper.statements.find(
    (node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'Parameter',
  ) as ts.TypeAliasDeclaration;
  const parameterType = checker.getTypeFromTypeNode(parameterNode.type);
  const helperErrors = [
    ...program.getSyntacticDiagnostics(helper),
    ...program.getSemanticDiagnostics(helper),
  ];
  if (helperErrors.length) {
    throw new Error(
      `Cannot resolve checker representation types: ${helperErrors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n')}`,
    );
  }
  const files = program
    .getSourceFiles()
    .filter(
      (source) =>
        !source.isDeclarationFile &&
        resolve(source.fileName) !== virtualPath &&
        !program.isSourceFileFromExternalLibrary(source),
    );
  const selected =
    filename === undefined
      ? files
      : files.filter((source) => resolve(source.fileName) === filename);
  if (filename !== undefined && !selected.length)
    throw new Error(
      'The target file is not a source file in this TypeScript project. Check --project and tsconfig inclusion.',
    );
  const diagnostics: CheckDiagnostic[] = [];
  for (const error of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) {
    if (error.category === ts.DiagnosticCategory.Error)
      diagnostics.push({
        file: resolve(configPath),
        line: 1,
        column: 1,
        kind: 'mismatch',
        code: 'typescript-configuration',
        message: ts.flattenDiagnosticMessageText(error.messageText, '\n'),
      });
  }
  for (const source of selected) {
    for (const error of [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ]) {
      if (error.category !== ts.DiagnosticCategory.Error) continue;
      const position = source.getLineAndCharacterOfPosition(error.start ?? 0);
      diagnostics.push({
        file: resolve(source.fileName),
        line: position.line + 1,
        column: position.character + 1,
        kind: 'mismatch',
        code: 'typescript-error',
        message: ts.flattenDiagnosticMessageText(error.messageText, '\n'),
      });
    }
  }
  return {
    program,
    checker,
    types,
    parameterType,
    files,
    selected,
    line,
    project: resolve(configPath),
    diagnostics,
  };
}

export type Project = ReturnType<typeof loadProject>;

/** Resolve actual exported symbols, including aliases and barrel re-exports. */
export function librarySymbols(project: Project): ReadonlyMap<string, ts.Symbol> {
  const found = new Map<string, ts.Symbol>();
  for (const source of project.program.getSourceFiles()) {
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
