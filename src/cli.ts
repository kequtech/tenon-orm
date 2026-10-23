#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { CaptureBaselineOptions } from './baseline.js';
import { adoptBaseline, captureBaseline } from './baseline.js';
import { generateDefinitions } from './generate.js';
import { migrate, migrationStatus, rollback } from './migrations.js';
import { createMigration } from './migrations/files.js';

const help = `tenon migrate|status|rollback [--directory migrations] [--namespace public]
tenon baseline capture|adopt [--directory migrations] [--namespace public]
baseline capture: [--schema name ...] (default: whole database schema)
tenon new <name> [--directory migrations] (no database required)
tenon generate [--namespace public] [--out src/generated-schema.ts] [--check]
rollback: --steps 1
Connection: DATABASE_URL
`;

function warn(message: string): void {
  process.stderr.write(`Warning: ${message}\n`);
}

/** Check without writing, or replace the complete generated file atomically. */
async function writeDefinitions(source: string, filename: string, check: boolean): Promise<void> {
  const output = resolve(filename);
  if (check) {
    let existing: string | undefined;
    try {
      existing = await readFile(output, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    if (existing !== source) {
      throw new Error(
        'Generated definitions are stale or missing; run tenon generate and commit the result.',
      );
    }
    process.stdout.write('Generated definitions are current.\n');
    return;
  }

  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, 'utf8');
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  process.stdout.write(`Generated ${output}\n`);
}

async function runBaseline(
  action: 'capture' | 'adopt',
  options: CaptureBaselineOptions,
): Promise<void> {
  warn(
    "Capture one shared baseline at the old ORM's final schema checkpoint. Each existing database must be at that checkpoint before adoption. Tenon does not compare schemas or remove the old ORM.",
  );
  if (action === 'capture') {
    const result = await captureBaseline({ ...options, onWarning: warn });
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
      directory: { type: 'string', default: 'migrations' },
      namespace: { type: 'string', default: 'public' },
      out: { type: 'string', default: 'src/generated-schema.ts' },
      schema: { type: 'string', multiple: true },
      check: { type: 'boolean', default: false },
      steps: { type: 'string', default: '1' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }

  const [command, argument] = positionals;
  // Validate explicitly supplied flags, not defaults. Silently ignoring --check
  // on migrate, for example, would turn an intended dry run into a schema change.
  const allowed = new Set(['help']);
  if (command !== 'generate') allowed.add('directory');
  if (command !== 'new') {
    allowed.add('namespace');
  }
  if (command === 'generate') {
    allowed.add('out');
    allowed.add('check');
  }
  if (command === 'rollback') {
    allowed.add('steps');
  }
  if (command === 'baseline' && argument === 'capture') {
    allowed.add('schema');
  }
  for (const token of tokens) {
    if (token.kind === 'option' && !allowed.has(token.name)) {
      throw new Error(`--${token.name} is not supported by ${command ?? 'this command'}.`);
    }
  }

  if (command === 'new') {
    if (positionals.length !== 2) {
      throw new Error('Use new <name> to create a migration pair.');
    }
    const files = await createMigration({ name: argument!, directory: values.directory });
    process.stdout.write(`Created ${files.upPath}\nCreated ${files.downPath}\n`);
    return;
  }

  const baseline = command === 'baseline' && (argument === 'capture' || argument === 'adopt');
  const valid = baseline
    ? positionals.length === 2
    : positionals.length === 1 &&
      ['migrate', 'generate', 'status', 'rollback'].includes(command ?? '');
  if (!valid) {
    throw new Error(
      'Choose new, baseline capture|adopt, migrate, generate, status, or rollback. Use --help for options.',
    );
  }

  const connection = process.env.DATABASE_URL;
  if (!connection) {
    throw new Error('DATABASE_URL is required.');
  }
  const options = { connection, directory: values.directory, namespace: values.namespace };
  if (baseline) {
    await runBaseline(argument, {
      ...options,
      ...(values.schema ? { schemas: values.schema } : {}),
    });
    return;
  }

  switch (command) {
    case 'generate': {
      const source = await generateDefinitions({
        connection,
        namespace: values.namespace,
        onWarning: warn,
      });
      await writeDefinitions(source, values.out, values.check);
      break;
    }
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
  // Do not print connection configuration or raw SQL/parameter payloads.
  process.stderr.write(`${error instanceof Error ? error.message : 'Database command failed.'}\n`);
  process.exitCode = 1;
});
