export type Dialect = "mysql" | "mssql" | "oracle" | "sqlite" | "postgres";

export type TokenKind =
  | "word" // unquoted identifier or keyword
  | "quoted" // quoted identifier: "x", `x`, [x]
  | "string" // string literal
  | "number"
  | "param" // :name named parameter
  | "punct" // operators and punctuation
  | "semicolon"
  | "ws"
  | "comment";

export interface Token {
  kind: TokenKind;
  text: string;
  /** upper-cased text for words */
  upper?: string;
  /** parameter name for kind=param */
  name?: string;
  start: number;
  end: number;
}

export class SqlTokenizeError extends Error {}

/**
 * Dialect-aware SQL tokenizer. It is deliberately conservative: anything it cannot
 * classify is an error, so the read-only checker never has to guess what a byte means.
 */
export function tokenize(sql: string, dialect: Dialect): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  const push = (kind: TokenKind, start: number, end: number, extra: Partial<Token> = {}) =>
    out.push({ kind, text: sql.slice(start, end), start, end, ...extra });

  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    // whitespace
    if (/\s/.test(c)) {
      const s = i;
      while (i < n && /\s/.test(sql[i])) i++;
      push("ws", s, i);
      continue;
    }
    // line comment: -- (and # in MySQL)
    if ((c === "-" && c2 === "-") || (c === "#" && dialect === "mysql")) {
      const s = i;
      while (i < n && sql[i] !== "\n") i++;
      push("comment", s, i);
      continue;
    }
    // block comment
    if (c === "/" && c2 === "*") {
      const s = i;
      // MySQL executable comments /*! ... */ and optimizer hints /*+ */ can carry SQL.
      if (dialect === "mysql" && sql[i + 2] === "!") {
        throw new SqlTokenizeError("MySQL executable comments (/*! */) are not allowed");
      }
      const close = sql.indexOf("*/", i + 2);
      if (close < 0) throw new SqlTokenizeError("Unterminated block comment");
      i = close + 2;
      push("comment", s, i);
      continue;
    }
    // string literals
    if (c === "'" || ((c === "N" || c === "n") && c2 === "'" && (dialect === "mssql" || dialect === "oracle"))) {
      const s = i;
      i += c === "'" ? 1 : 2;
      for (;;) {
        if (i >= n) throw new SqlTokenizeError("Unterminated string literal");
        if (sql[i] === "\\" && dialect === "mysql") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push("string", s, i);
      continue;
    }
    // Oracle q-quote strings q'[...]'
    if ((c === "q" || c === "Q") && c2 === "'" && dialect === "oracle") {
      const s = i;
      const open = sql[i + 2];
      const pairs: Record<string, string> = { "[": "]", "(": ")", "{": "}", "<": ">" };
      const close = (pairs[open] ?? open) + "'";
      const end = sql.indexOf(close, i + 3);
      if (end < 0) throw new SqlTokenizeError("Unterminated q-quoted string");
      i = end + 2;
      push("string", s, i);
      continue;
    }
    // double-quoted: identifier in ANSI dialects, string in MySQL (default sql_mode)
    if (c === '"') {
      const s = i;
      i++;
      for (;;) {
        if (i >= n) throw new SqlTokenizeError("Unterminated quoted identifier");
        if (sql[i] === "\\" && dialect === "mysql") {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push(dialect === "mysql" ? "string" : "quoted", s, i);
      continue;
    }
    if (c === "`" && (dialect === "mysql" || dialect === "sqlite")) {
      const s = i;
      const end = sql.indexOf("`", i + 1);
      if (end < 0) throw new SqlTokenizeError("Unterminated backtick identifier");
      i = end + 1;
      push("quoted", s, i);
      continue;
    }
    if (c === "[" && (dialect === "mssql" || dialect === "sqlite")) {
      const s = i;
      const end = sql.indexOf("]", i + 1);
      if (end < 0) throw new SqlTokenizeError("Unterminated bracket identifier");
      i = end + 1;
      push("quoted", s, i);
      continue;
    }
    // named parameter :name (not :: cast, not := assignment)
    if (c === ":" && /[A-Za-z_]/.test(c2 ?? "") && sql[i - 1] !== ":") {
      const s = i;
      i++;
      while (i < n && /[A-Za-z0-9_]/.test(sql[i])) i++;
      push("param", s, i, { name: sql.slice(s + 1, i) });
      continue;
    }
    // numbers
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(c2 ?? ""))) {
      const s = i;
      while (i < n && /[0-9.eE]/.test(sql[i])) {
        if ((sql[i] === "e" || sql[i] === "E") && (sql[i + 1] === "-" || sql[i + 1] === "+")) i++;
        i++;
      }
      push("number", s, i);
      continue;
    }
    // words (identifiers / keywords); @var and @@var in MSSQL/MySQL are words too
    if (/[A-Za-z_@$#\u0080-￿]/.test(c)) {
      const s = i;
      i++;
      while (i < n && /[A-Za-z0-9_@$#\u0080-￿]/.test(sql[i])) i++;
      const text = sql.slice(s, i);
      push("word", s, i, { upper: text.toUpperCase() });
      continue;
    }
    if (c === ";") {
      push("semicolon", i, i + 1);
      i++;
      continue;
    }
    // punctuation / operators
    const ops = ["<=>", "<>", "!=", ">=", "<=", "||", "::", ":=", "->>", "->"];
    const op = ops.find((o) => sql.startsWith(o, i));
    if (op) {
      push("punct", i, i + op.length);
      i += op.length;
      continue;
    }
    if ("(),.+-*/%=<>|&^~!?{}".includes(c) || c === ":") {
      push("punct", i, i + 1);
      i++;
      continue;
    }
    throw new SqlTokenizeError(`Unexpected character '${c}' at position ${i}`);
  }
  return out;
}

/** Tokens that carry meaning (no whitespace or comments). */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== "ws" && t.kind !== "comment");
}
