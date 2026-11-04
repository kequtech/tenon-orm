// Deliberately recognize only PostgreSQL's two deparsed forms of a text ANY array
// made from unconstrained varchar literals. This is not a general SQL normalizer.
// In particular, varchar(n), domains, collations, functions and other casts are opaque.

function tokens(sql: string): string[] | undefined {
  const result: string[] = [];
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i);
    const match =
      /^(?:\s+|'(?:[^']|'')*'|"(?:[^"]|"")*"|[A-Za-z_][A-Za-z_0-9$]*|::|[()[\],.=])/.exec(rest);
    if (!match) return;
    const token = match[0];
    if (token.trim()) result.push(token);
    i += token.length;
  }
  return result;
}

function closing(input: readonly string[], start: number): number {
  const stack: string[] = [];
  for (let i = start; i < input.length; i++) {
    const token = input[i]!;
    if (token === '(' || token === '[') stack.push(token === '(' ? ')' : ']');
    else if (token === ')' || token === ']') {
      if (stack.pop() !== token) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

function unwrap(input: readonly string[]): readonly string[] {
  while (input[0] === '(' && closing(input, 0) === input.length - 1) input = input.slice(1, -1);
  return input;
}

function topLevel(input: readonly string[], wanted: string): number {
  for (let i = 0; i < input.length; i++) {
    if (input[i] === wanted) return i;
    if (input[i] === '(' || input[i] === '[') {
      i = closing(input, i);
      if (i < 0) return -1;
    }
  }
  return -1;
}

function isType(input: readonly string[], type: 'text' | 'varchar', array = false): boolean {
  if (array) {
    if (input.at(-2) !== '[' || input.at(-1) !== ']') return false;
    input = input.slice(0, -2);
  }
  // inspectSchema deparses with search_path=pg_catalog. Quoted user types in
  // other schemas remain qualified and cannot be mistaken for these builtins.
  if ((input[0] === 'pg_catalog' || input[0] === '"pg_catalog"') && input[1] === '.')
    input = input.slice(2);
  return (
    (input.length === 1 && [type, `"${type}"`].includes(input[0]!)) ||
    (type === 'varchar' && input.join(' ') === 'character varying')
  );
}

function cast(input: readonly string[], type: 'text' | 'varchar', array = false) {
  input = unwrap(input);
  const at = topLevel(input, '::');
  if (at < 0 || !isType(input.slice(at + 1), type, array)) return;
  return unwrap(input.slice(0, at));
}

/** Undefined means unrecognized; callers must retain the original difference. */
export function checkTextArrayKey(definition: string): string | undefined {
  const input = tokens(definition);
  if (!input || input[0] !== 'CHECK' || input[1] !== '(') return;
  const end = closing(input, 1);
  if (end < 0) return;
  const suffix = input.slice(end + 1);
  if (!['', 'NOT VALID', 'NO INHERIT', 'NO INHERIT NOT VALID'].includes(suffix.join(' '))) return;
  const body = unwrap(input.slice(2, end));
  const equals = topLevel(body, '=');
  if (equals <= 0) return;
  const left = body.slice(0, equals);
  const right = body.slice(equals + 1);
  if (right[0] !== 'ANY' || right[1] !== '(' || closing(right, 1) !== right.length - 1) return;
  let array = unwrap(right.slice(2, -1));
  const wholeCast = cast(array, 'text', true);
  const perElement = wholeCast === undefined;
  array = wholeCast ?? array;
  if (array[0] !== 'ARRAY' || array[1] !== '[' || closing(array, 1) !== array.length - 1) return;
  let elements = array.slice(2, -1);
  if (!elements.length) return;
  const literals: string[] = [];
  while (elements.length) {
    const comma = topLevel(elements, ',');
    let element: readonly string[] | undefined = comma < 0 ? elements : elements.slice(0, comma);
    if (perElement) element = cast(element, 'text');
    if (!element) return;
    element = cast(element, 'varchar');
    if (!element || element.length !== 1 || !element[0]!.startsWith("'")) return;
    literals.push(element[0]!);
    if (comma < 0) break;
    elements = elements.slice(comma + 1);
    if (!elements.length) return;
  }
  return JSON.stringify({ left, literals, suffix });
}
