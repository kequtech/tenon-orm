import { spawnSync } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import './clean.mjs';

const result = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'config/tsconfig.build.json'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit' },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// tsc preserves the shebang but does not mark the emitted CLI executable.
await chmod(new URL('../dist/cli.js', import.meta.url), 0o755);
