import { rm } from 'node:fs/promises';

// Resolve from the script so cleaning never depends on the caller's directory.
await Promise.all(['dist/', '.test-dist/'].map(path =>
  rm(new URL(`../${path}`, import.meta.url), { recursive: true, force: true }),
));
