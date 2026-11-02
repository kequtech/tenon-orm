import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Resolve from Tenon, including its isolated dependencies under strict package managers. */
export async function installedDocumentation() {
  return Promise.all(
    ['@kequtech/tenon-orm', '@kequtech/pgclear', '@kequtech/pgclear-jobs'].map(async (name) => {
      const root = fileURLToPath(new URL('../', import.meta.resolve(name)));
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        version: string;
      };
      return {
        name,
        version: manifest.version,
        readme: join(root, 'README.md'),
        guides: join(root, 'docs'),
      };
    }),
  );
}
