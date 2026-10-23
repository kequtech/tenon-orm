export function validateName(value: string): void {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    Buffer.byteLength(value) > 63
  ) {
    throw new Error('Identifiers must contain 1–63 UTF-8 bytes and no NUL character.');
  }
}
export function quote(name: string): string {
  validateName(name);
  return `"${name.replaceAll('"', '""')}"`;
}
export function qualified(namespace: string, table: string): string {
  return `${quote(namespace)}.${quote(table)}`;
}

/** Shared by query assembly and static checking so separators produce identical SQL. */
export function joinSeparator(value: unknown): string {
  switch (value) {
    case 'AND':
      return ' AND ';
    case 'OR':
      return ' OR ';
    case ',':
      return ', ';
    default:
      throw new Error('sql.join separator must be "AND", "OR", or ",".');
  }
}
