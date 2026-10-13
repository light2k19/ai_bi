import { type Dialect, tokenize } from "./tokenizer";

export interface BoundQuery {
  sql: string;
  /** positional values for mysql/sqlite (? placeholders) */
  values: unknown[];
  /** named values for mssql (@p0) and oracle (:p0) */
  named: Record<string, unknown>;
}

export class ParamBindError extends Error {}

/**
 * Rewrite `:name` placeholders into the driver's native placeholder style.
 * Array values expand into a comma-separated placeholder list so `IN (:regions)` works.
 * Values are never interpolated into the SQL text.
 */
export function bindParams(sql: string, params: Record<string, unknown>, dialect: Dialect): BoundQuery {
  const tokens = tokenize(sql, dialect);
  let out = "";
  const values: unknown[] = [];
  const named: Record<string, unknown> = {};
  let counter = 0;
  const placeholder = (v: unknown) => {
    const idx = counter++;
    switch (dialect) {
      case "mysql":
      case "sqlite":
        values.push(normalizeValue(v, dialect));
        return "?";
      case "postgres":
        values.push(normalizeValue(v, dialect));
        return `$${values.length}`;
      case "mssql":
        named[`p${idx}`] = normalizeValue(v, dialect);
        return `@p${idx}`;
      case "oracle":
        named[`p${idx}`] = normalizeValue(v, dialect);
        return `:p${idx}`;
    }
  };
  for (const t of tokens) {
    if (t.kind !== "param") {
      out += t.text;
      continue;
    }
    const name = t.name!;
    if (!(name in params)) throw new ParamBindError(`Missing value for parameter :${name}`);
    const v = params[name];
    if (Array.isArray(v)) {
      if (v.length === 0) {
        // IN () is invalid SQL; NULL matches nothing, which is the intended semantics
        out += "NULL";
      } else {
        out += v.map((x) => placeholder(x)).join(", ");
      }
    } else {
      out += placeholder(v);
    }
  }
  // strip a single trailing semicolon: drivers reject it in some dialects (Oracle)
  out = out.replace(/;\s*$/, "");
  return { sql: out, values, named };
}

function normalizeValue(v: unknown, dialect: Dialect): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean" && (dialect === "sqlite" || dialect === "oracle")) return v ? 1 : 0;
  // ISO date strings stay strings: every engine converts 'YYYY-MM-DD' implicitly or via TO_DATE,
  // and avoiding JS Date objects avoids timezone shifts in the drivers.
  if (v !== null && typeof v === "object" && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}
