import type { ThemeTokens } from "@aibi/runtime-api";

export type Obj = Record<string, unknown>;
export type Row = Record<string, unknown>;

export function isPlain(v: unknown): v is Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-merge `source` over `target` (returns a new value).
 * - plain objects merge key by key
 * - an array of objects merges index by index (so `series: [{ barWidth: 20 }]` tweaks the first series)
 * - a plain object merged over an array applies to every element (e.g. `yAxis: { min: 0 }` for dual axes)
 * - anything else replaces
 */
export function deepMerge(target: unknown, source: unknown): unknown {
  if (source === undefined) return target;
  if (isPlain(target) && isPlain(source)) {
    const out: Obj = { ...target };
    for (const [k, v] of Object.entries(source)) out[k] = deepMerge(target[k], v);
    return out;
  }
  if (Array.isArray(target) && isPlain(source)) return target.map((t) => deepMerge(t, source));
  if (Array.isArray(target) && Array.isArray(source) && source.length > 0 && source.every(isPlain)) {
    const n = Math.max(target.length, source.length);
    return Array.from({ length: n }, (_, i) => (i < source.length ? deepMerge(target[i], source[i]) : target[i]));
  }
  return source;
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : undefined;
}

export function strArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x !== "");
  if (typeof v === "string" && v) return [v];
  return [];
}

export function objArr(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter(isPlain) : [];
}

export function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isPlain(v)) for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
}

const ABBREV: Record<string, string> = { ly: "LY", py: "PY", pct: "%", ytd: "YTD", mtd: "MTD", qtd: "QTD", id: "ID", kpi: "KPI", avg: "Avg", qty: "Qty", yoy: "YoY", mom: "MoM" };

/** "ly_revenue" → "LY revenue", "margin_pct" → "Margin %" */
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

/** Colour with alpha; supports #rgb, #rrggbb, rgb()/rgba(). Other inputs are returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length === 3) return `rgba(${parts.join(",")},${alpha})`;
  }
  return c;
}

/** Axis labels: compact money / numbers, whole percents. */
export function axisSpec(spec: string | undefined): string {
  if (!spec) return "compact";
  const [kind, arg] = spec.split(":");
  switch (kind) {
    case "currency":
    case "compactCurrency":
      return arg && /^[A-Z]{3}$/.test(arg) ? `compactCurrency:${arg}` : "compactCurrency";
    case "percent":
      return "percent:0";
    case "percentRaw":
      return "percentRaw:0";
    case "number":
    case "decimal":
    case "integer":
    case "compact":
      return "compact";
    default:
      return spec;
  }
}

/** Guess an x-label format from the values when none is given. */
export function detectXFormat(values: unknown[]): string | undefined {
  const sample = values.filter((v) => v !== null && v !== undefined).slice(0, 50);
  if (!sample.length) return undefined;
  if (sample.every((v) => typeof v === "string" && /^\d{4}-\d{2}$/.test(v))) return "month";
  if (sample.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T00:00(:00(\.0+)?)?Z?)?$/.test(v))) return "date";
  return undefined;
}

export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  const step = m <= 1 ? 1 : m <= 1.2 ? 1.2 : m <= 1.5 ? 1.5 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 3 ? 3 : m <= 4 ? 4 : m <= 5 ? 5 : m <= 6 ? 6 : m <= 8 ? 8 : 10;
  return step * p;
}

/** 1, 2, 3, 5 or 10 × 10^k at or above v. */
export function niceStep(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return Number(((m <= 1 ? 1 : m <= 2 ? 2 : m <= 3 ? 3 : m <= 5 ? 5 : 10) * p).toPrecision(12));
}

export function keyOf(v: unknown): string {
  return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function themeAlpha(theme: ThemeTokens, light: number, dark: number): number {
  return theme.mode === "dark" ? dark : light;
}

export function escapeHtml(v: unknown): string {
  return keyOf(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
