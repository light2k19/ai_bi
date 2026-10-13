import type { Frame } from "@aibi/runtime-api";
import type { ColumnType } from "@aibi/transforms";

export type Row = Record<string, unknown>;
export type Obj = Record<string, unknown>;

export function isPlain(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export function strArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x !== "");
  if (typeof v === "string" && v) return [v];
  return [];
}

export function keyOf(v: unknown): string {
  return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
}

const ABBREV: Record<string, string> = { ly: "LY", py: "PY", pct: "%", ytd: "YTD", mtd: "MTD", qtd: "QTD", id: "ID", kpi: "KPI", avg: "Avg", qty: "Qty", yoy: "YoY", mom: "MoM" };

export function humanize(col: string): string {
  const words = col
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[_\s.-]+/)
    .filter(Boolean)
    .map((w) => ABBREV[w.toLowerCase()] ?? w.toLowerCase());
  if (!words.length) return col;
  const first = words[0];
  words[0] = first === first.toUpperCase() ? first : first[0].toUpperCase() + first.slice(1);
  return words.join(" ");
}

export function columnType(frame: Frame, key: string): ColumnType {
  const c = frame.columns.find((x) => x.name === key);
  if (c) return c.type;
  const v = frame.rows.find((r) => r[key] !== null && r[key] !== undefined)?.[key];
  return typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";
}

const RATIO = /(^|_)(pct|percent|percentage|ratio|rate|share|margin_pct|attainment|growth|conversion|churn|utili[sz]ation)($|_)/i;
const MONEY = /(revenue|amount|sales|cost|price|profit|budget|target|spend|income|expense|margin|gmv|ebitda?|cash|balance|(^|_)(arr|mrr|value)($|_))/i;
const NOT_SUMMABLE = /(^|_)(id|year|month|quarter|week|day|rank|no|number|code|zip)$/i;

/** Sensible default format for a column from its type, name and values. */
export function autoSpec(frame: Frame, key: string): string | undefined {
  const type = columnType(frame, key);
  const values = frame.rows.slice(0, 200).map((r) => r[key]).filter((v) => v !== null && v !== undefined);
  if (type === "date") {
    if (values.every((v) => typeof v === "string" && /^\d{4}-\d{2}$/.test(v))) return "month";
    if (values.some((v) => typeof v === "string" && /[T ]\d{2}:\d{2}/.test(v) && !/T00:00(:00)?/.test(v))) return "datetime";
    return "date";
  }
  if (type === "string" && values.length && values.every((v) => typeof v === "string" && /^\d{4}-\d{2}$/.test(v))) return "month";
  if (type !== "number") return undefined;
  const nums = values.map(toNum).filter((v): v is number => v !== null);
  if (NOT_SUMMABLE.test(key)) return "text";
  if (RATIO.test(key) && nums.every((v) => Math.abs(v) <= 5)) return "percent";
  if (MONEY.test(key) && !RATIO.test(key)) return "currency";
  if (nums.every((v) => Number.isInteger(v))) return "integer";
  return "number";
}

export function isRatioSpec(spec: string | undefined): boolean {
  return !!spec && /^percent/.test(spec);
}

export function isSummable(key: string, spec: string | undefined): boolean {
  return !isRatioSpec(spec) && spec !== "text" && !NOT_SUMMABLE.test(key);
}

export type Agg = "sum" | "avg" | "min" | "max" | "count" | "countDistinct" | "none";

export function aggregate(values: unknown[], how: Agg): number | null {
  if (how === "none") return null;
  if (how === "count") return values.filter((v) => v !== null && v !== undefined && v !== "").length;
  if (how === "countDistinct") return new Set(values.filter((v) => v !== null && v !== undefined).map(keyOf)).size;
  const nums = values.map(toNum).filter((v): v is number => v !== null);
  if (!nums.length) return null;
  switch (how) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Compare for sorting: numbers numerically, strings naturally, nulls last. */
export function compareValues(a: unknown, b: unknown): number {
  const an = a === null || a === undefined || a === "";
  const bn = b === null || b === undefined || b === "";
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return collator.compare(keyOf(a), keyOf(b));
}

/** Background for a heat cell: t = 0 (bad, red) … 1 (good, green). */
export function heatBackground(t: number, strength = 26): string {
  const x = Math.max(0, Math.min(1, t));
  const inner = x < 0.5 ? `color-mix(in srgb, var(--warning) ${Math.round(x * 200)}%, var(--danger))` : `color-mix(in srgb, var(--success) ${Math.round((x - 0.5) * 200)}%, var(--warning))`;
  return `color-mix(in srgb, ${inner} ${strength}%, transparent)`;
}

/** Sequential accent background for magnitudes (pivot heat). */
export function accentBackground(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  return `color-mix(in srgb, var(--accent) ${Math.round(4 + x * 46)}%, transparent)`;
}
