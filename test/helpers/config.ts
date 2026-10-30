import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TenonConfig } from '../../src/index.js';

/** Simple value-only config fixtures; custom-codec tests write executable modules directly. */
export async function writeConfig(directory: string, config: TenonConfig): Promise<string> {
  const filename = join(directory, 'tenon.config.mjs');
  await writeFile(filename, `export const main = ${JSON.stringify(config)};\n`);
  return filename;
}
