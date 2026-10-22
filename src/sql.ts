import { TenonError } from './errors.js';

export function validateName(value: string): void {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    Buffer.byteLength(value) > 63
  ) {
    throw new TenonError('Identifiers must contain 1–63 UTF-8 bytes and no NUL character.');
  }
}
export function quote(name: string): string {
  validateName(name);
  return `"${name.replaceAll('"', '""')}"`;
}
export function qualified(namespace: string, table: string): string {
  return `${quote(namespace)}.${quote(table)}`;
}
