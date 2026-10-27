import { quote } from '../sql.js';

export const baselineHeader = '-- Tenon baseline captured by pg_dump.\n';

/** Bridge pg_dump's plain-text script to transactional SQL execution. */
export function prepareBaselineSql(dump: string, namespace: string): string {
  // Recent pg_dump versions bracket psql scripts with a random restrict key.
  // Remove only the outer pair; SQL bodies containing similar text stay intact.
  const opening = /^\\restrict ([A-Za-z0-9]+)\r?$/m.exec(dump);
  if (opening) {
    const closing = dump.lastIndexOf(`\\unrestrict ${opening[1]}`);
    if (closing < opening.index) {
      throw new Error('pg_dump output has an incomplete psql wrapper.');
    }
    dump =
      dump.slice(0, closing) + dump.slice(closing).replace(/^\\unrestrict [A-Za-z0-9]+\r?\n?/, '');
    dump = dump.slice(0, opening.index) + dump.slice(opening.index + opening[0].length);
  }
  // Only the native preamble and bookkeeping schema declaration need adapting. Never
  // rewrite SET/CREATE text inside functions or other captured object bodies.
  const start = dump.indexOf('\n-- Name:');
  const preamble = start === -1 ? dump : dump.slice(0, start);
  let objects = start === -1 ? '' : dump.slice(start);
  const declaration = `\nCREATE SCHEMA ${quote(namespace)};`;
  const position = objects.indexOf(declaration);
  const section = objects.lastIndexOf('\n-- Name:', position);
  const isSchemaDeclaration =
    position !== -1 &&
    objects
      .slice(Math.max(section, 0), position)
      .split('\n')
      .every((line) => !line.trim() || line.startsWith('--'));
  if (isSchemaDeclaration) {
    objects = objects.replace(declaration, `\nCREATE SCHEMA IF NOT EXISTS ${quote(namespace)};`);
  }
  return (
    baselineHeader +
    preamble
      .replace(/^SET /gm, 'SET LOCAL ')
      .replace(
        "SELECT pg_catalog.set_config('search_path', '', false);",
        "SELECT pg_catalog.set_config('search_path', '', true);",
      ) +
    objects
  );
}
