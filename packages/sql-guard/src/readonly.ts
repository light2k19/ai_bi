import { type Dialect, type Token, tokenize, significant, SqlTokenizeError } from "./tokenizer";

export interface ReadOnlyOptions {
  /** schemas (lower-case) that queries may not reference, e.g. mysql, sys */
  deniedSchemas?: string[];
  /** if set, only these schemas may be referenced as qualifiers */
  allowedSchemas?: string[];
  /** tables (lower-case, optionally schema-qualified) that may not be referenced */
  deniedTables?: string[];
}

export interface ReadOnlyResult {
  ok: boolean;
  errors: string[];
  /** named parameters found, in order of first appearance */
  params: string[];
}

/** Keywords that must never appear outside literals in a read-only query. */
const BANNED = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE_INTO",
  "DROP", "ALTER", "CREATE", "TRUNCATE", "RENAME", "COMMENT_ON",
  "GRANT", "REVOKE", "DENY",
  "EXEC", "EXECUTE", "CALL", "DO", "HANDLER",
  "INTO", // SELECT INTO (MSSQL creates tables), INTO OUTFILE/DUMPFILE (MySQL)
  "LOCK", "UNLOCK",
  "DECLARE", "SET", "USE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "START", "TRANSACTION",
  "SHUTDOWN", "KILL", "RECONFIGURE", "DBCC", "BACKUP", "RESTORE", "CHECKPOINT",
  "LOAD", "LOAD_FILE", "OUTFILE", "DUMPFILE", "BULK", "COPY",
  "OPENROWSET", "OPENQUERY", "OPENDATASOURCE", "OPENXML",
  "WAITFOR", "PRAGMA", "ATTACH", "DETACH", "VACUUM", "ANALYZE", "REINDEX",
  "PREPARE", "DEALLOCATE", "FLUSH", "PURGE", "RESET", "INSTALL", "UNINSTALL",
  "SLEEP", "BENCHMARK", "PG_SLEEP", "GET_LOCK", "RELEASE_LOCK",
  "DBMS_LOCK", "DBMS_SQL", "DBMS_PIPE", "DBMS_SCHEDULER", "DBMS_JOB", "DBMS_LOB", "DBMS_XMLGEN", "UTL_HTTP", "UTL_FILE", "UTL_TCP", "UTL_SMTP", "UTL_INADDR", "HTTPURITYPE",
  "SYSTEM_USER_CONTEXT",
]);

/** Prefixes of procedure names that are always rejected (MSSQL extended / system procs, Oracle packages). */
const BANNED_PREFIXES = ["XP_", "SP_", "DBMS_", "UTL_", "SYS.DBMS", "SYS.UTL"];

const DEFAULT_DENIED_SCHEMAS: Record<Dialect, string[]> = {
  mysql: ["mysql", "performance_schema", "sys"],
  mssql: ["sys", "master", "msdb", "tempdb", "model"],
  oracle: ["sys", "system", "dba", "ctxsys", "xdb", "mdsys"],
  sqlite: [],
  postgres: ["pg_catalog"],
};

/**
 * Check that a SQL text is a single read-only query (SELECT, or WITH ... SELECT).
 * This is one layer of several: database grants and read-only transactions are the
 * hard stop; this check gives fast, explainable feedback and blocks obvious abuse.
 */
export function checkReadOnly(sql: string, dialect: Dialect, options: ReadOnlyOptions = {}): ReadOnlyResult {
  const errors: string[] = [];
  let tokens: Token[];
  try {
    tokens = tokenize(sql, dialect);
  } catch (e) {
    const msg = e instanceof SqlTokenizeError ? e.message : String(e);
    return { ok: false, errors: [msg], params: [] };
  }
  const sig = significant(tokens);
  const params: string[] = [];
  for (const t of sig) if (t.kind === "param" && !params.includes(t.name!)) params.push(t.name!);

  if (sig.length === 0) return { ok: false, errors: ["Query is empty"], params };

  // single statement: a semicolon may only appear as the very last token
  const semis = sig.filter((t) => t.kind === "semicolon");
  if (semis.length > 1 || (semis.length === 1 && sig[sig.length - 1].kind !== "semicolon")) {
    errors.push("Only a single statement is allowed (remove the extra ';')");
  }

  // first keyword (skipping opening parentheses) must be SELECT or WITH
  const first = sig.find((t) => !(t.kind === "punct" && t.text === "("));
  if (!first || first.kind !== "word" || !["SELECT", "WITH"].includes(first.upper!)) {
    errors.push(`Query must start with SELECT or WITH (found '${first?.text ?? ""}')`);
  }

  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    if (t.kind !== "word") continue;
    const u = t.upper!;
    // allow function-style uses of words that are keywords elsewhere
    const next = sig[k + 1];
    const prev = sig[k - 1];
    const isQualifiedPart = prev?.kind === "punct" && prev.text === ".";
    if (u === "SET" && isQualifiedPart) continue; // a column named "set" qualified as t.set
    if (u === "REPLACE" && next?.text === "(") continue; // REPLACE() string function
    if (u === "INTO") {
      errors.push("SELECT ... INTO is not allowed");
      continue;
    }
    if (u === "FOR" && next?.kind === "word" && ["UPDATE", "SHARE"].includes(next.upper!)) {
      errors.push(`'FOR ${next.upper}' row locking is not allowed`);
      k++;
      continue;
    }
    if (u === "LOCK" && prev?.upper === "SHARE") continue; // handled above via FOR SHARE
    if (BANNED.has(u) && !isQualifiedPart) {
      errors.push(`Keyword '${u}' is not allowed in a read-only query`);
      continue;
    }
    if (BANNED_PREFIXES.some((p) => u.startsWith(p))) {
      errors.push(`'${t.text}' is not allowed`);
      continue;
    }
    // @@ system variables and @variables: reading a few is harmless, assignments are blocked by SET/:= checks
  }

  // assignment operator (MySQL user variables)
  if (sig.some((t) => t.kind === "punct" && t.text === ":=")) errors.push("Variable assignment (:=) is not allowed");

  // schema qualifiers: word/quoted followed by '.'
  const denied = new Set([...(options.deniedSchemas ?? DEFAULT_DENIED_SCHEMAS[dialect])].map((s) => s.toLowerCase()));
  const allowed = options.allowedSchemas?.map((s) => s.toLowerCase());
  const deniedTables = new Set((options.deniedTables ?? []).map((s) => s.toLowerCase()));
  const qualifiedNames = collectQualifiedNames(sig);
  const aliases = collectAliases(sig);
  for (const parts of qualifiedNames) {
    if (parts.length >= 2) {
      if (aliases.has(parts[0])) continue; // table alias like o.amount
      const qualifiers = parts.slice(0, -1);
      const hit = qualifiers.find((q) => denied.has(q));
      if (hit) errors.push(`Schema '${hit}' is not accessible`);
    }
    const full = parts.join(".");
    const tableOnly = parts[parts.length - 1];
    if (deniedTables.has(full) || deniedTables.has(tableOnly)) errors.push(`Table '${full}' is not accessible`);
  }
  // table references after FROM / JOIN: deny-list and schema allow-list
  for (let k = 0; k < sig.length - 1; k++) {
    const t = sig[k];
    if (t.kind === "word" && (t.upper === "FROM" || t.upper === "JOIN")) {
      const parts: string[] = [];
      let j = k + 1;
      while (sig[j] && (sig[j].kind === "word" || sig[j].kind === "quoted")) {
        parts.push(unquote(sig[j].text).toLowerCase());
        if (sig[j + 1]?.kind === "punct" && sig[j + 1].text === ".") j += 2;
        else break;
      }
      if (!parts.length) continue;
      const name = parts.join(".");
      if (deniedTables.has(name) || deniedTables.has(parts[parts.length - 1])) errors.push(`Table '${name}' is not accessible`);
      if (allowed && allowed.length && parts.length >= 2) {
        const schema = parts[parts.length - 2];
        if (!allowed.includes(schema)) errors.push(`Schema '${schema}' is not in the allowed list`);
      }
    }
  }

  return { ok: errors.length === 0, errors: dedupe(errors), params };
}

function dedupe(a: string[]) {
  return [...new Set(a)];
}

export function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("`") && s.endsWith("`")) || (s.startsWith("[") && s.endsWith("]"))) {
    return s.slice(1, -1);
  }
  return s;
}

function collectQualifiedNames(sig: Token[]): string[][] {
  const out: string[][] = [];
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    if (!(t.kind === "word" || t.kind === "quoted")) continue;
    if (sig[k - 1]?.kind === "punct" && sig[k - 1].text === ".") continue; // not a chain start
    const parts = [unquote(t.text).toLowerCase()];
    let j = k;
    while (sig[j + 1]?.kind === "punct" && sig[j + 1].text === "." && (sig[j + 2]?.kind === "word" || sig[j + 2]?.kind === "quoted")) {
      parts.push(unquote(sig[j + 2].text).toLowerCase());
      j += 2;
    }
    if (parts.length > 1) out.push(parts);
  }
  return out;
}

/** Aliases introduced as `table alias` or `table AS alias`, plus CTE names. */
function collectAliases(sig: Token[]): Set<string> {
  const out = new Set<string>();
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    if (t.kind === "word" && t.upper === "AS") {
      const nx = sig[k + 1];
      if (nx && (nx.kind === "word" || nx.kind === "quoted")) out.add(unquote(nx.text).toLowerCase());
    }
    // `FROM x y` / `JOIN x.y z`
    if (t.kind === "word" && (t.upper === "FROM" || t.upper === "JOIN" || (t.text === "," && false))) {
      let j = k + 1;
      while (sig[j] && (sig[j].kind === "word" || sig[j].kind === "quoted" || sig[j].text === ".")) {
        const after = sig[j + 1];
        if ((sig[j].kind === "word" || sig[j].kind === "quoted") && after && (after.kind === "word" || after.kind === "quoted") && sig[j - 0]?.text !== ".") {
          if (!isClauseKeyword(after)) out.add(unquote(after.text).toLowerCase());
          break;
        }
        j++;
      }
    }
    // CTE names: WITH name AS ( / , name AS (
    if ((t.kind === "word" && t.upper === "WITH") || (t.kind === "punct" && t.text === ",")) {
      const nx = sig[k + 1];
      if (nx && (nx.kind === "word" || nx.kind === "quoted") && sig[k + 2]?.upper === "AS") out.add(unquote(nx.text).toLowerCase());
    }
  }
  // comma-separated FROM lists: `FROM a x, b y`
  for (let k = 0; k < sig.length - 2; k++) {
    if (sig[k].kind === "punct" && sig[k].text === ",") {
      const a = sig[k + 1];
      const b = sig[k + 2];
      if ((a.kind === "word" || a.kind === "quoted") && b && (b.kind === "word" || b.kind === "quoted") && !isClauseKeyword(b) && !isClauseKeyword(a)) {
        out.add(unquote(b.text).toLowerCase());
      }
    }
  }
  return out;
}

const CLAUSE_KEYWORDS = new Set([
  "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "FETCH", "UNION", "EXCEPT", "INTERSECT", "MINUS",
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER", "ON", "USING", "AS", "WINDOW", "QUALIFY",
  "CONNECT", "START", "PIVOT", "UNPIVOT", "NATURAL", "APPLY", "WITH", "FOR", "SELECT", "FROM", "AND", "OR",
  "WHEN", "THEN", "ELSE", "END", "CASE", "IS", "NOT", "NULL", "IN", "BETWEEN", "LIKE", "DESC", "ASC", "BY",
]);
function isClauseKeyword(t: Token) {
  return t.kind === "word" && CLAUSE_KEYWORDS.has(t.upper!);
}

