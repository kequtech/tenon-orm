#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { generateDefinitions } from './generate.js';
import { adoptBaseline, createMigration, migrate, migrationStatus, rollback } from './migrations.js';
import { captureBaseline } from './baseline.js';
import { TenonError } from './errors.js';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    directory: { type: 'string', default: 'migrations' }, namespace: { type: 'string', default: 'public' },
    out: { type: 'string', default: 'src/generated-schema.ts' },
    schema: { type: 'string', multiple: true },
    check: { type: 'boolean', default: false }, steps: { type: 'string', default: '1' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    process.stdout.write('tenon migrate|generate|status|rollback [--directory migrations] [--namespace public]\ntenon baseline capture|adopt [--directory migrations] [--namespace public]\nbaseline capture: [--schema name ...] (default: whole database schema)\ntenon new <name> [--directory migrations] (no database required)\ngenerate: --out src/generated-schema.ts [--check]\nrollback: --steps 1\nConnection: DATABASE_URL\n');
    return;
  }
  const command = positionals[0];
  if (command === 'new') {
    if (positionals.length !== 2) throw new TenonError('Use new <name> to create a migration pair.');
    const files = await createMigration({ name: positionals[1]!, directory: values.directory });
    process.stdout.write(`Created ${files.upPath}\nCreated ${files.downPath}\n`);
    return;
  }
  const baseline = command === 'baseline' && positionals.length === 2 && ['capture', 'adopt'].includes(positionals[1]!);
  if (!baseline && (positionals.length !== 1 || !['migrate', 'generate', 'status', 'rollback'].includes(command ?? ''))) throw new TenonError('Choose new, baseline capture|adopt, migrate, generate, status, or rollback. Use --help for options.');
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new TenonError('DATABASE_URL is required.');
  const options = { connection, directory: values.directory, namespace: values.namespace };
  if (baseline) {
    process.stderr.write('Warning: Capture one shared baseline at the old ORM\'s final schema checkpoint. Each existing database must be at that checkpoint before adoption. Tenon does not compare schemas or remove the old ORM.\n');
    if (positionals[1] === 'capture') {
      const result = await captureBaseline({ ...options, ...(values.schema ? { schemas: values.schema } : {}),
        onWarning: message => process.stderr.write(`Warning: ${message}\n`) });
      process.stdout.write(`Captured ${result.upPath}. Source history and data were not changed. Commit this file and generated definitions.\n`);
    } else {
      process.stderr.write('Warning: Adoption records 0001_baseline without executing its SQL. Use migrate for a fresh database. Disable the old migration runner when switching to Tenon.\n');
      const completed = await adoptBaseline(options);
      process.stdout.write(`baseline adopt: ${completed.length ? completed.join(', ') : 'already recorded'}\n`);
    }
    return;
  }
  if (command === 'generate') {
    const source = await generateDefinitions({ ...options, onWarning: message => process.stderr.write(`Warning: ${message}\n`) });
    const output = resolve(values.out);
    if (values.check) {
      let existing: string | undefined;
      try { existing = await readFile(output, 'utf8'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      if (existing !== source) throw new TenonError('Generated definitions are stale or missing; run tenon generate and commit the result.');
      process.stdout.write('Generated definitions are current.\n');
    } else {
      await mkdir(dirname(output), { recursive: true });
      const temporary = `${output}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, source, 'utf8'); await rename(temporary, output); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      process.stdout.write(`Generated ${output}\n`);
    }
  } else if (command === 'status') process.stdout.write(`${JSON.stringify(await migrationStatus(options), null, 2)}\n`);
  else {
    const completed = command === 'migrate' ? await migrate(options) : await rollback({ ...options, steps: Number(values.steps) });
    process.stdout.write(`${command}: ${completed.length ? completed.join(', ') : 'nothing to do'}\n`);
  }
}

main().catch((error: unknown) => {
  // Do not print database connection configuration or raw SQL/parameter payloads.
  process.stderr.write(`${error instanceof Error ? error.message : 'Database command failed.'}\n`);
  process.exitCode = 1;
});
