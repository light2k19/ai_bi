import type { Frame } from "@aibi/runtime-api";

export type Row = Record<string, unknown>;

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

const ABBREV: Record<string, string> = { ly: "LY", py: "PY", pct: "%", ytd: "YTD", mtd: "MTD", qtd: "QTD", kpi: "KPI", avg: "Avg", qty: "Qty", yoy: "YoY" };

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

/** "{{row.revenue}}", "{{ revenue | currency }}", "{{rows[0].revenue}}" → "revenue"; plain names pass through. */
export function stripBinding(s: string): string {
  const m = /^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/.exec(s);
  if (!m) return s.trim();
  const expr = m[1].split(/\|(?!\|)/)[0].trim();
  return expr.replace(/^(row|rows\[\d+\]|data\.\w+\.rows\[\d+\])\./, "").trim();
}

/**
 * A measure reference: column name (possibly written as a binding) or a literal number.
 * `raw` is the unresolved prop (from widget.props); `resolved` the runtime-resolved one.
 */
export type MeasureRef = { col: string } | { num: number } | null;

export function measureRef(raw: unknown, resolved: unknown): MeasureRef {
  for (const v of [raw, resolved]) {
    if (typeof v === "number" && Number.isFinite(v)) return { num: v };
    if (typeof v === "string" && v.trim()) {
      const name = stripBinding(v);
      if (name) return { col: name };
    }
  }
  return null;
}

export type Agg = "sum" | "avg" | "min" | "max" | "first" | "last" | "count";

export function reduceColumn(rows: Row[], col: string, agg: string | undefined): number | null {
  if (agg === "count") return rows.length;
  const how = (agg ?? (rows.length === 1 ? "first" : "sum")) as Agg;
  const vals = rows.map((r) => toNum(r[col]));
  const nums = vals.filter((v): v is number => v !== null);
  if (!nums.length) return null;
  switch (how) {
    case "first":
      return vals.find((v) => v !== null) ?? null;
    case "last":
      return [...vals].reverse().find((v) => v !== null) ?? null;
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
    default:
      return nums.reduce((a, b) => a + b, 0);
  }
}

export function measureValue(ref: MeasureRef, frame: Frame | undefined, agg: string | undefined): number | null {
  if (!ref) return null;
  if ("num" in ref) return ref.num;
  if (!frame) return null;
  const has = frame.columns.some((c) => c.name === ref.col) || frame.rows.some((r) => ref.col in r);
  if (has) return reduceColumn(frame.rows, ref.col, agg);
  return toNum(ref.col);
}

export interface KpiSpec {
  label?: string;
  format?: string;
  aggregate?: string;
  value: MeasureRef;
  compare: MeasureRef;
  compareLabel?: string;
  target: MeasureRef;
  invert: boolean;
  sparkline?: string;
  sparklineX?: string;
  icon?: string;
  color?: string;
  note?: string;
}

export function kpiSpec(raw: Record<string, unknown>, resolved: Record<string, unknown>, fallbackLabel: boolean): KpiSpec {
  const value = measureRef(raw.value, resolved.value);
  const label = str(resolved.label) ?? str(resolved.title) ?? (fallbackLabel && value && "col" in value ? humanize(value.col) : undefined);
  const sparkRef = measureRef(raw.sparkline, resolved.sparkline);
  const sparkXRef = measureRef(raw.sparklineX, resolved.sparklineX);
  return {
    label,
    format: str(resolved.format),
    aggregate: str(resolved.aggregate),
    value,
    compare: measureRef(raw.compare, resolved.compare),
    compareLabel: str(resolved.compareLabel),
    target: measureRef(raw.target, resolved.target),
    invert: resolved.invert === true,
    sparkline: sparkRef && "col" in sparkRef ? sparkRef.col : undefined,
    sparklineX: sparkXRef && "col" in sparkXRef ? sparkXRef.col : undefined,
    icon: str(resolved.icon),
    color: str(resolved.color),
    note: str(resolved.note),
  };
}

export interface KpiValues {
  value: number | null;
  compare: number | null;
  target: number | null;
  /** relative change vs compare (ratio), null when not computable */
  delta: number | null;
  spark: number[];
}

const collator = new Intl.Collator(undefined, { numeric: true });

export function kpiValues(spec: KpiSpec, frame: Frame | undefined): KpiValues {
  const value = measureValue(spec.value, frame, spec.aggregate);
  const compare = measureValue(spec.compare, frame, spec.aggregate);
  const target = measureValue(spec.target, frame, spec.aggregate);
  const delta = value !== null && compare !== null && compare !== 0 ? (value - compare) / Math.abs(compare) : null;
  let spark: number[] = [];
  if (spec.sparkline && frame) {
    let rows = frame.rows;
    if (spec.sparklineX) {
      const x = spec.sparklineX;
      rows = [...rows].sort((a, b) => {
        const av = a[x];
        const bv = b[x];
        if (typeof av === "number" && typeof bv === "number") return av - bv;
        return collator.compare(String(av ?? ""), String(bv ?? ""));
      });
    }
    spark = rows.map((r) => toNum(r[spec.sparkline!])).filter((v): v is number => v !== null);
  }
  return { value, compare, target, delta, spark };
}
