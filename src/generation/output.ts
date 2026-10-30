import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { definitionDiff } from './diff.js';

/** Check without writing, or replace the complete generated file atomically. */
export async function writeDefinitions(
  source: string,
  filename: string,
  check: boolean,
): Promise<void> {
  const output = resolve(filename);
  if (check) {
    let existing: string;
    try {
      existing = await readFile(output, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
      throw new Error(
        `Generated definitions file is missing: ${output}\nRun tenon generate with the same options, omitting --check, then commit the result.`,
      );
    }
    if (existing !== source) {
      throw new Error(
        `Generated definitions differ: ${output}\n${definitionDiff(existing, source)}\nRun tenon generate with the same options, omitting --check, then commit the result.`,
      );
    }
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
}
