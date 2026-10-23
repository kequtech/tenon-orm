import { fileURLToPath } from 'node:url';

/** Add to a connection's plugins in normal SafeQL configuration. */
export const safeqlPlugin = {
  package: fileURLToPath(new URL('./safeql/plugin.js', import.meta.url)),
};

/** Register as `tenon` in ESLint and enable `tenon/check-composition`. */
export { eslintPlugin } from './safeql/eslint.js';
