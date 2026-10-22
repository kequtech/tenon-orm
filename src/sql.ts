import { TenonError } from './errors.js';

export interface Statement { readonly text: string; readonly values: readonly unknown[] }
export function validateName(value: string): void {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > 63) throw new TenonError('Identifiers must contain 1–63 UTF-8 bytes and no NUL character.');
}
export function quote(name: string): string {
  validateName(name);
  return `"${name.replaceAll('"', '""')}"`;
}
export function qualified(namespace: string, table: string): string { return `${quote(namespace)}.${quote(table)}`; }
export function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TenonError(`${name} must be a plain object.`);
  return value as Record<string, unknown>;
}
