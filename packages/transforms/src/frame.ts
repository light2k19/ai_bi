export type ColumnType = "string" | "number" | "date" | "boolean" | "json";

export interface Column {
  name: string;
  type: ColumnType;
}

/** Wire format returned by the data gateway (compact). */
export interface QueryResult {
  columns: Column[];
  rows: unknown[][];
  truncated?: boolean;
  durationMs?: number;
  cached?: boolean;
}

/** In-memory format used by transforms, widgets and page scripts. */
export interface Frame {
  columns: Column[];
  rows: Record<string, unknown>[];
  meta?: { truncated?: boolean; durationMs?: number; cached?: boolean; fetchedAt?: string; error?: string };
}

export function toFrame(r: QueryResult): Frame {
  const names = r.columns.map((c) => c.name);
  return {
    columns: r.columns,
    rows: r.rows.map((row) => {
      const o: Record<string, unknown> = {};
      names.forEach((n, i) => (o[n] = row[i]));
      return o;
    }),
    meta: { truncated: r.truncated, durationMs: r.durationMs, cached: r.cached, fetchedAt: new Date().toISOString() },
  };
}

export function toResult(f: Frame): QueryResult {
  return { columns: f.columns, rows: f.rows.map((r) => f.columns.map((c) => r[c.name])) };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export function inferType(values: unknown[]): ColumnType {
  let seen: ColumnType | null = null;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    let t: ColumnType;
    if (typeof v === "number" || typeof v === "bigint") t = "number";
    else if (typeof v === "boolean") t = "boolean";
    else if (v instanceof Date) t = "date";
    else if (typeof v === "string") t = ISO_DATE.test(v) ? "date" : "string";
    else t = "json";
    if (seen && seen !== t) return seen === "number" && t === "string" ? "string" : seen === "date" && t === "string" ? "string" : seen;
    seen = t;
  }
  return seen ?? "string";
}

export function inferColumns(rows: Record<string, unknown>[], order?: string[]): Column[] {
  const names = order ?? [...new Set(rows.slice(0, 200).flatMap((r) => Object.keys(r)))];
  return names.map((name) => ({ name, type: inferType(rows.slice(0, 500).map((r) => r[name])) }));
}

export function frameFromRows(rows: Record<string, unknown>[], order?: string[]): Frame {
  return { columns: inferColumns(rows, order), rows };
}
