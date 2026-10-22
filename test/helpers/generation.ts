import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { GenerateOptions } from '../../src/index.js';
import { generateDefinitions } from '../../src/index.js';

const run = promisify(execFile);

export async function checkGeneratedTypes(
  options: GenerateOptions & { directory: string },
  consumer: string,
): Promise<void> {
  // Compile a real consumer of newly generated types, not a textual snapshot of
  // declaration syntax. No package build or live connection is needed by the TypeScript consumer.
  const source = await generateDefinitions(options);
  await writeFile(join(options.directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(options.directory, 'definitions.ts'), source);
  const filename = join(options.directory, 'consumer.ts');
  await writeFile(filename, consumer);
  const config = join(options.directory, 'tsconfig.json');
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        types: ['node'],
        typeRoots: [resolve('node_modules/@types')],
      },
      files: ['consumer.ts'],
    }),
  );
  await run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--project', config]);
}

export const typeAssertions = `
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
  type Assert<T extends true> = T;
`;
