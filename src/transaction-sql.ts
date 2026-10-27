/** Read only the command prefix, leaving strings, bodies and SQL syntax to PostgreSQL. */
function commandPrefix(sql: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < sql.length && words.length < 3) {
    if (/\s/.test(sql[i]!)) {
      i++;
      continue;
    }
    if (!words.length && sql[i] === ';') {
      i++;
      continue;
    }
    if (sql.startsWith('--', i)) {
      i += 2;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') {
        i++;
      }
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    if (sql[i] === '(') {
      words.push('(');
      break;
    }
    const word = /^[A-Za-z_\u0080-\uFFFF][A-Za-z_0-9$\u0080-\uFFFF]*/.exec(sql.slice(i));
    if (!word) {
      break;
    }
    words.push(word[0].toUpperCase());
    i += word[0].length;
  }
  return words;
}

/** Public SQL cannot take ownership away from Tenon's callback transaction. */
export function validateTransactionSql(sql: string, name: string): void {
  const [first, second, third] = commandPrefix(sql);
  const rollbackTo =
    first === 'ROLLBACK' &&
    (second === 'TO' || ((second === 'WORK' || second === 'TRANSACTION') && third === 'TO'));
  if (
    first === 'BEGIN' ||
    first === 'COMMIT' ||
    first === 'END' ||
    first === 'ABORT' ||
    (first === 'ROLLBACK' && !rollbackTo) ||
    (first === 'START' && second === 'TRANSACTION') ||
    // A SQL prepared statement named transaction is not a prepared transaction.
    (first === 'PREPARE' && second === 'TRANSACTION' && third !== 'AS' && third !== '(')
  ) {
    throw new Error(
      `${name} cannot start or end a transaction; use db.transaction() to manage transaction boundaries.`,
    );
  }
}
