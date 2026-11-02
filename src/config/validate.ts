import { plainObject } from '../validation.js';

export function configSection(
  value: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const config = plainObject(value, label);
  for (const key of Object.keys(config)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} option: ${key}`);
  }
  return config;
}

/** Check the shared shape without resolving credentials or constructing a pool. */
export function configObject(value: unknown): Record<string, unknown> {
  const config = configSection(value, 'Tenon config', [
    'connection',
    'onQuery',
    'generate',
    'migrations',
    'baseline',
    'check',
    'session',
    'timeouts',
  ]);
  if (!('connection' in config)) throw new Error('Tenon config must declare connection.');
  if (config.onQuery !== undefined && typeof config.onQuery !== 'function') {
    throw new Error('Tenon config onQuery must be a function.');
  }
  return config;
}
