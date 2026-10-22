import { TenonError } from '../errors.js';

/** Find statement starts without splitting quoted strings, DO bodies or comments. */
export function validateMigrationSql(sql: string, filename: string): void {
  let statement = '';
  let quote: string | undefined;
  let commentDepth = 0;
  let lineComment = false;
  let escapeString = false;
  function check() {
    const words = statement.trim().replace(/\s+/g, ' ').toUpperCase();
    if (
      /^(BEGIN|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\b|^START TRANSACTION\b|^PREPARE TRANSACTION\b/.test(
        words,
      )
    ) {
      throw new TenonError(
        `Migration ${filename} must not contain transaction-control statements; Tenon owns the transaction.`,
      );
    }
    statement = '';
  }
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (lineComment) {
      if (ch === '\n' || ch === '\r') {
        lineComment = false;
        statement += ' ';
      }
      continue;
    }
    if (commentDepth) {
      if (ch === '/' && next === '*') {
        commentDepth++;
        i++;
      } else if (ch === '*' && next === '/') {
        commentDepth--;
        i++;
        statement += ' ';
      }
      continue;
    }
    if (quote) {
      if (quote.startsWith('$')) {
        if (sql.startsWith(quote, i)) {
          i += quote.length - 1;
          quote = undefined;
        }
      } else if (escapeString && ch === '\\') {
        i++;
      } else if (ch === quote) {
        if (next === quote) {
          i++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      commentDepth = 1;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      escapeString = ch === "'" && /(?:^|\W)[eE]$/.test(sql.slice(0, i));
      quote = ch;
      statement += ' quoted ';
      continue;
    }
    // A dollar inside an unquoted identifier is not the start of a SQL body.
    if (ch === '$' && (i === 0 || !/[A-Za-z_0-9$\u0080-\uFFFF]/.test(sql[i - 1]!))) {
      const match = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
      if (match) {
        quote = match[0];
        i += quote.length - 1;
        statement += ' body ';
        continue;
      }
    }
    if (ch === ';') {
      check();
    } else {
      statement += ch;
    }
  }
  if (quote || commentDepth) {
    throw new TenonError(`Unterminated SQL string or comment in migration ${filename}.`);
  }
  check();
}
