import { define } from '../../src/index.js';

// Ordinary imports compose a registry without loading unrelated SQL definitions.
export const echo_values = define<
  { label: string; enabled: boolean },
  [label: string, enabled: boolean]
>('SELECT $1::text AS label, $2::boolean AS enabled', { returns: 'many' });
