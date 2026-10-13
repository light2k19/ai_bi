import type { Filter } from "./page";

/** Runtime value of each filter type, as seen by bindings ({{filters.<id>.<field>}}). */
export interface DateRangeValue {
  preset?: string;
  /** inclusive start, YYYY-MM-DD */
  start: string;
  /** inclusive end, YYYY-MM-DD */
  end: string;
  /** day after end, for `col >= :start AND col < :endExclusive` */
  endExclusive: string;
  /** previous period of equal length */
  prevStart: string;
  prevEnd: string;
  prevEndExclusive: string;
  /** same period last year */
  lyStart: string;
  lyEnd: string;
  lyEndExclusive: string;
  days: number;
}
export interface SelectValue {
  value: string | number | boolean | null;
}
export interface MultiSelectValue {
  values: (string | number | boolean)[];
  /** true when the user selected "all" (values then lists every known option) */
  all: boolean;
  /** 1 when all, else 0 — handy in SQL: (:all = 1 OR col IN (:values)) */
  allFlag: 0 | 1;
}
export interface SearchValue {
  text: string;
  /** '%text%' for LIKE */
  like: string;
}
export interface NumberRangeValue {
  min: number | null;
  max: number | null;
}
export interface ToggleValue {
  on: boolean;
  flag: 0 | 1;
}
export type FilterValue = DateRangeValue | SelectValue | MultiSelectValue | SearchValue | NumberRangeValue | ToggleValue;

/* ───────── date helpers (pure Y-M-D arithmetic in UTC to avoid DST issues) ───────── */

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function parseYmd(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00Z`);
}
export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
export function addMonths(s: string, n: number): string {
  const d = parseYmd(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return ymd(d);
}
export function diffDays(a: string, b: string): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86400000);
}
/** Today in the caller's local timezone as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function presetRange(preset: string, today: string): { start: string; end: string } {
  const [y, m] = today.split("-").map(Number);
  const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
  const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const quarterStart = `${y}-${String(qStartMonth).padStart(2, "0")}-01`;
  switch (preset) {
    case "today":
      return { start: today, end: today };
    case "yesterday":
      return { start: addDays(today, -1), end: addDays(today, -1) };
    case "last7d":
      return { start: addDays(today, -6), end: today };
    case "last30d":
      return { start: addDays(today, -29), end: today };
    case "last90d":
      return { start: addDays(today, -89), end: today };
    case "MTD":
      return { start: monthStart, end: today };
    case "QTD":
      return { start: quarterStart, end: today };
    case "YTD":
      return { start: `${y}-01-01`, end: today };
    case "lastMonth": {
      const s = addMonths(monthStart, -1);
      return { start: s, end: addDays(monthStart, -1) };
    }
    case "lastQuarter": {
      const s = addMonths(quarterStart, -3);
      return { start: s, end: addDays(quarterStart, -1) };
    }
    case "lastYear":
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    case "last12m":
      return { start: addMonths(monthStart, -11), end: today };
    default:
      return { start: `${y}-01-01`, end: today };
  }
}

export function dateRangeValue(start: string, end: string, preset?: string): DateRangeValue {
  if (end < start) [start, end] = [end, start];
  const days = diffDays(start, end) + 1;
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  const lyStart = addMonths(start, -12);
  const lyEnd = addMonths(end, -12);
  return {
    preset,
    start,
    end,
    endExclusive: addDays(end, 1),
    prevStart,
    prevEnd,
    prevEndExclusive: addDays(prevEnd, 1),
    lyStart,
    lyEnd,
    lyEndExclusive: addDays(lyEnd, 1),
    days,
  };
}

/** Compute the runtime value of a filter from a raw input (default or user selection). */
export function filterValue(f: Filter, raw: unknown, ctx: { today?: string; options?: (string | number | boolean)[] } = {}): FilterValue {
  const today = ctx.today ?? localToday();
  switch (f.type) {
    case "dateRange": {
      // accept a bare preset string ("YTD") as well as { preset } / { start, end }
      const r = (typeof raw === "string" ? { preset: raw } : (raw ?? { preset: "YTD" })) as { preset?: string; start?: string; end?: string };
      if (r.preset && r.preset !== "custom") {
        const p = presetRange(r.preset, today);
        return dateRangeValue(p.start, p.end, r.preset);
      }
      const start = r.start ?? presetRange("YTD", today).start;
      const end = r.end ?? today;
      return dateRangeValue(start.slice(0, 10), end.slice(0, 10), "custom");
    }
    case "select": {
      const v = raw && typeof raw === "object" && "value" in (raw as object) ? (raw as SelectValue).value : raw;
      return { value: (v ?? ctx.options?.[0] ?? null) as SelectValue["value"] };
    }
    case "multiSelect": {
      const v = raw && typeof raw === "object" && !Array.isArray(raw) && "values" in (raw as object) ? raw as Partial<MultiSelectValue> : null;
      const isAll = raw === undefined || raw === null || raw === "all" || (v?.all ?? false);
      if (isAll) return { values: ctx.options ?? [], all: true, allFlag: 1 };
      const values = (Array.isArray(raw) ? raw : (v?.values ?? [])) as MultiSelectValue["values"];
      return { values, all: false, allFlag: 0 };
    }
    case "search": {
      const text = typeof raw === "string" ? raw : ((raw as SearchValue | undefined)?.text ?? "");
      return { text, like: `%${text}%` };
    }
    case "numberRange": {
      const r = (raw ?? {}) as { min?: number | null; max?: number | null };
      return { min: r.min ?? f.min ?? null, max: r.max ?? f.max ?? null };
    }
    case "toggle": {
      const on = typeof raw === "boolean" ? raw : Boolean((raw as ToggleValue | undefined)?.on ?? false);
      return { on, flag: on ? 1 : 0 };
    }
  }
}

/** Fields each filter type exposes to bindings, for validation and AI documentation. */
export const FILTER_FIELDS: Record<Filter["type"], string[]> = {
  dateRange: ["preset", "start", "end", "endExclusive", "prevStart", "prevEnd", "prevEndExclusive", "lyStart", "lyEnd", "lyEndExclusive", "days"],
  select: ["value"],
  multiSelect: ["values", "all", "allFlag"],
  search: ["text", "like"],
  numberRange: ["min", "max"],
  toggle: ["on", "flag"],
};

/**
 * Runtime values of all filters from their defaults (or from raw overrides), e.g. for AI previews,
 * exports and first render. Dataset-backed multiSelect options are unknown here, so "all" yields [].
 */
export function defaultFilterValues(
  filters: Filter[],
  raw: Record<string, unknown> = {},
  ctx: { today?: string; options?: Record<string, (string | number | boolean)[]> } = {},
): Record<string, FilterValue> {
  const out: Record<string, FilterValue> = {};
  for (const f of filters) {
    const staticOpts = Array.isArray(f.options) ? f.options.map((o) => o.value) : undefined;
    const r = f.id in raw ? raw[f.id] : f.default;
    out[f.id] = filterValue(f, r, { today: ctx.today, options: ctx.options?.[f.id] ?? staticOpts });
  }
  return out;
}
