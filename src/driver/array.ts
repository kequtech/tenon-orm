import type postgres from 'postgres';

const initialization = new WeakMap<postgres.Sql, Promise<void>>();

/** Preserve driver scalar parsers and serializers; replace only lossy array parsing. */
export function prepareArrays(sql: postgres.Sql): Promise<void> {
  const existing = initialization.get(sql);
  if (existing) return existing;
  const ready = (async () => {
    const customArrays = new Set(
      Object.values(sql.options.types as Record<string, postgres.PostgresType<unknown>>).flatMap(
        (type) => type.from,
      ),
    );
    const arrays = await sql<{ oid: number; element: number; delimiter: string }[]>`
      SELECT t.typarray AS oid, t.oid AS element, t.typdelim AS delimiter
      FROM pg_catalog.pg_type t WHERE t.typarray <> 0`;
    for (const type of arrays) {
      if (customArrays.has(type.oid)) continue;
      const scalar = sql.options.parsers[type.element] ?? ((value: string) => value);
      sql.options.parsers[type.oid] = (value: string) => parseArray(value, scalar, type.delimiter);
    }
  })();
  initialization.set(sql, ready);
  void ready.catch(() => initialization.delete(sql));
  return ready;
}

/** PostgreSQL text arrays: only unquoted NULL is null; quoted values use the scalar parser. */
export function parseArray(
  text: string,
  parse: (value: string) => unknown,
  delimiter = ',',
): unknown[] {
  let position = text.startsWith('[') ? text.indexOf('=') + 1 : 0;
  function array(): unknown[] {
    if (text[position++] !== '{') throw new Error('Invalid PostgreSQL array.');
    const values: unknown[] = [];
    while (position < text.length && text[position] !== '}') {
      if (text[position] === '{') values.push(array());
      else {
        let value = '';
        const quoted = text[position] === '"';
        if (quoted) position++;
        while (position < text.length) {
          const char = text[position]!;
          if (char === '\\') {
            position++;
            value += text[position++] ?? '';
          } else if (quoted && char === '"') {
            position++;
            break;
          } else if (!quoted && (char === delimiter || char === '}')) break;
          else {
            value += char;
            position++;
          }
        }
        values.push(!quoted && value === 'NULL' ? null : parse(value));
      }
      if (text[position] === delimiter) position++;
      else if (text[position] !== '}') throw new Error('Invalid PostgreSQL array separator.');
    }
    if (text[position++] !== '}') throw new Error('Unterminated PostgreSQL array.');
    return values;
  }
  const result = array();
  if (position !== text.length) throw new Error('Unexpected PostgreSQL array suffix.');
  return result;
}
