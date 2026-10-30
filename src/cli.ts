#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultCodecs } from '@kequtech/pgclear';
import type { DatabaseToolOptions } from './migrations/connection.js';
import { adoptBaseline, captureBaseline } from './baseline.js';
import { describeFlags, inspectionSettings } from './inspection/cli.js';
import { loadConfig } from './config/load.js';
import { initConfig } from './config/init.js';
import { generateDefinitions } from './generate.js';
import { writeDefinitions } from './generation/output.js';
import { validatePath } from './validation.js';
import { describeQuery } from './describe.js';
import { migrate, migrationStatus, rollback } from './migrations.js';
import { createMigration } from './migrations/files.js';

const help = `tenon init [--config path] (create config without a database)
tenon migrate|status|rollback [--directory migrations] [--namespace public]
tenon baseline capture|adopt [--directory migrations] [--namespace public]
baseline capture: [--schema name ...] [--connection native-uri] (default: whole database schema)
tenon new <name> [--directory migrations] (no database required)
tenon generate [--out path] [--namespace public] [--check] [--config path]
tenon describe <query.sql> [--role name] [--search-path schemas] [--time-zone zone]
tenon check [file.ts[:line]] [--project tsconfig.json] [--json]
generate/check/describe require tenon.config.ts, .mts, .js or .mjs, or --config path.
describe: [--connect-timeout-ms 3000] [--statement-timeout-ms 5000] [--lock-timeout-ms 1000]
describe emits JSON metadata; it does not execute the query or verify result annotations.
check compares source contracts; mismatches, unchecked sites and no sites fail. Unproven types are notes.
rollback: --steps 1
All commands accept --config path. Migration commands fall back to DATABASE_URL only without config.
`;

function warn(message: string): void {
  process.stderr.write(`Warning: ${message}\n`);
}

async function runBaseline(
  action: 'capture' | 'adopt',
  options: DatabaseToolOptions & { readonly schemas?: readonly string[] },
): Promise<void> {
  warn(
    "Capture one shared baseline at the old ORM's final schema checkpoint. Each existing database must be at that checkpoint before adoption. Tenon does not compare schemas or remove the old ORM.",
  );
  if (action === 'capture') {
    if (typeof options.connection !== 'string') {
      throw new Error(
        'Baseline capture needs a native libpq URI. Pass --connection or use a string config connection.',
      );
    }
    const result = await captureBaseline({
      ...options,
      connection: options.connection,
      onWarning: warn,
    });
    process.stdout.write(
      `Captured ${result.upPath}. Source history and data were not changed. Commit this file and generated definitions.\n`,
    );
  } else {
    warn(
      'Adoption records 0001_baseline without executing its SQL. Use migrate for a fresh database. Disable the old migration runner when switching to Tenon.',
    );
    const completed = await adoptBaseline(options);
    process.stdout.write(
      `baseline adopt: ${completed.length ? completed.join(', ') : 'already recorded'}\n`,
    );
  }
}

async function main(): Promise<void> {
  const { positionals, values, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      directory: { type: 'string' },
      connection: { type: 'string' },
      namespace: { type: 'string' },
      config: { type: 'string' },
      out: { type: 'string' },
      check: { type: 'boolean', default: false },
      schema: { type: 'string', multiple: true },
      steps: { type: 'string', default: '1' },
      help: { type: 'boolean', default: false },
      project: { type: 'string' },
      json: { type: 'boolean', default: false },
      ...describeFlags,
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }

  const [command, argument] = positionals;
  for (const name of ['out', 'directory', 'project'] as const) {
    if (values[name] !== undefined) validatePath(values[name], `--${name}`);
  }
  // Validate explicitly supplied flags, not defaults. Silently ignoring --check
  // on migrate, for example, would turn an intended dry run into a schema change.
  const allowed = new Set(['help']);
  if (!['describe', 'check', 'generate', 'init'].includes(command ?? '')) allowed.add('directory');
  if (!['new', 'describe', 'check', 'init'].includes(command ?? '')) {
    allowed.add('namespace');
  }
  if (command === 'rollback') {
    allowed.add('steps');
  }
  if (command === 'generate') {
    allowed.add('out');
    allowed.add('check');
  }
  allowed.add('config');
  if (command === 'baseline' && argument === 'capture') {
    allowed.add('schema');
    allowed.add('connection');
  }
  if (command === 'check') {
    allowed.add('project');
    allowed.add('json');
  }
  if (command === 'describe' || command === 'check') {
    for (const name of Object.keys(describeFlags)) allowed.add(name);
  }
  for (const token of tokens) {
    if (token.kind === 'option' && !allowed.has(token.name)) {
      throw new Error(`--${token.name} is not supported by ${command ?? 'this command'}.`);
    }
  }

  if (command === 'init') {
    if (positionals.length !== 1)
      throw new Error('Use init [--config path] to create configuration.');
    const path = await initConfig(values.config);
    process.stdout.write(`Created ${path}\nSet DATABASE_URL before running database commands.\n`);
    return;
  }

  if (command === 'new') {
    if (positionals.length !== 2) {
      throw new Error('Use new <name> to create a migration pair.');
    }
    const config = await loadConfig(values.config, false);
    const files = await createMigration({
      name: argument!,
      directory: values.directory ?? config?.migrations?.directory ?? 'migrations',
    });
    process.stdout.write(`Created ${files.upPath}\nCreated ${files.downPath}\n`);
    return;
  }

  const baseline = command === 'baseline' && (argument === 'capture' || argument === 'adopt');
  const valid =
    command === 'check'
      ? positionals.length <= 2
      : baseline || command === 'describe'
        ? positionals.length === 2
        : positionals.length === 1 &&
          ['migrate', 'generate', 'status', 'rollback'].includes(command ?? '');
  if (!valid) {
    throw new Error(
      'Choose init, new, baseline capture|adopt, migrate, generate, describe <query.sql>, check [file.ts[:line]], status, or rollback. Use --help for options.',
    );
  }

  if (command === 'generate' || command === 'check' || command === 'describe') {
    const config = await loadConfig(values.config);
    if (command === 'generate') {
      const out = values.out === undefined ? config.generate?.out : resolve(values.out);
      if (out === undefined) throw new Error('Configure generate.out or pass --out.');
      const namespace =
        values.namespace ?? config.generate?.namespace ?? config.migrations?.namespace;
      const source = await generateDefinitions({
        connection: config.connection,
        onWarning: warn,
        ...(namespace !== undefined && { namespace }),
      });
      await writeDefinitions(source, out, values.check);
      process.stdout.write(
        values.check ? 'Generated definitions are current.\n' : `Generated ${out}\n`,
      );
      return;
    }
    const flags = inspectionSettings(values);
    const settings = {
      connection: config.connection,
      session: { ...config.session, ...flags.session },
      timeouts: { ...config.timeouts, ...flags.timeouts },
    };
    if (command === 'describe') {
      const result = await describeQuery({ ...settings, query: await readFile(argument!, 'utf8') });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const { checkQueries } = await import('./check.js');
    const report = await checkQueries({
      ...settings,
      ...config.check,
      ...(argument === undefined ? {} : { target: argument }),
      ...(values.project === undefined ? {} : { project: values.project }),
    });
    if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      for (const diagnostic of report.diagnostics)
        process.stdout.write(
          `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} [${diagnostic.kind}] ${diagnostic.code}: ${diagnostic.message}\n`,
        );
      process.stdout.write(
        `${report.queries.length} queries, ${report.queries.filter((query) => query.status === 'analysed').length} analysed, ${report.queries.filter((query) => query.status === 'unchecked').length} unchecked, ${report.queries.reduce((count, query) => count + query.variants, 0)} variants described; ${report.diagnostics.filter((diagnostic) => diagnostic.kind === 'mismatch').length} mismatches, ${report.diagnostics.filter((diagnostic) => diagnostic.kind === 'unproven').length} unproven findings.\n`,
      );
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const config = await loadConfig(values.config, false);
  const capture = command === 'baseline' && argument === 'capture';
  const connection =
    values.connection ??
    (capture ? config?.baseline?.connection : undefined) ??
    config?.connection ??
    process.env.DATABASE_URL;
  if (!connection) throw new Error('DATABASE_URL is required.');
  const options = {
    connection:
      typeof connection === 'string' ? connection : { ...connection, codecs: defaultCodecs },
    directory: values.directory ?? config?.migrations?.directory ?? 'migrations',
    namespace: values.namespace ?? config?.migrations?.namespace ?? 'public',
  };
  if (baseline) {
    const schemas = values.schema ?? (capture ? config?.baseline?.schemas : undefined);
    await runBaseline(argument, {
      ...options,
      ...(schemas !== undefined && { schemas }),
    });
    return;
  }

  switch (command) {
    case 'status':
      process.stdout.write(`${JSON.stringify(await migrationStatus(options), null, 2)}\n`);
      break;
    default: {
      const completed =
        command === 'migrate'
          ? await migrate(options)
          : await rollback({ ...options, steps: Number(values.steps) });
      process.stdout.write(
        `${command}: ${completed.length ? completed.join(', ') : 'nothing to do'}\n`,
      );
    }
  }
}

main().catch((error: unknown) => {
  // Report diagnostics without connection configuration or query parameter payloads.
  process.stderr.write(`${error instanceof Error ? error.message : 'Database command failed.'}\n`);
  process.exitCode = 1;
});
