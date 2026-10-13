/** Value formatting shared by widgets, text bindings, and exports. */

export type FormatSpec =
  | "number" | "integer" | "decimal" | "currency" | "percent" | "percentRaw" | "compact" | "compactCurrency"
  | "date" | "datetime" | "month" | "quarter" | "year" | "text"
  | string;

export interface FormatOptions {
  locale?: string;
  currency?: string;
  digits?: number;
}

const nf = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: string, o: Intl.NumberFormatOptions) {
  const key = locale + JSON.stringify(o);
  let f = nf.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, o);
    nf.set(key, f);
  }
  return f;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format a value. `spec` may carry digits after a colon, e.g. "currency:0", "percent:1",
 * or a currency code for currency, e.g. "currency:EUR".
 */
export function formatValue(v: unknown, spec: FormatSpec | undefined, opts: FormatOptions = {}): string {
  if (v === null || v === undefined) return "";
  const locale = opts.locale ?? "en-US";
  const [kind, arg] = String(spec ?? "").split(":");
  const digitsArg = arg !== undefined && /^\d+$/.test(arg) ? Number(arg) : undefined;
  const currency = arg && /^[A-Z]{3}$/.test(arg) ? arg : (opts.currency ?? "USD");
  const digits = digitsArg ?? opts.digits;
  switch (kind) {
    case "": {
      if (typeof v === "number") return numberFormat(locale, { maximumFractionDigits: Math.abs(v) < 10 ? 2 : Math.abs(v) < 1000 ? 1 : 0 }).format(v);
      return String(v);
    }
    case "number":
    case "decimal": {
      const n = toNum(v);
      return n === null ? String(v) : numberFormat(locale, { minimumFractionDigits: digits ?? 0, maximumFractionDigits: digits ?? 2 }).format(n);
    }
    case "integer": {
      const n = toNum(v);
      return n === null ? String(v) : numberFormat(locale, { maximumFractionDigits: 0 }).format(n);
    }
    case "currency": {
      const n = toNum(v);
      return n === null ? String(v) : numberFormat(locale, { style: "currency", currency, minimumFractionDigits: digits ?? 0, maximumFractionDigits: digits ?? 0 }).format(n);
    }
    case "compact": {
      const n = toNum(v);
      return n === null ? String(v) : numberFormat(locale, { notation: "compact", maximumFractionDigits: digits ?? 1 }).format(n);
    }
    case "compactCurrency": {
      const n = toNum(v);
      return n === null ? String(v) : numberFormat(locale, { style: "currency", currency, notation: "compact", maximumFractionDigits: digits ?? 1 }).format(n);
    }
    case "percent": {
      // value is a ratio (0.25 → 25%)
      const n = toNum(v);
      return n === null ? String(v) : numberFormat(locale, { style: "percent", minimumFractionDigits: digits ?? 1, maximumFractionDigits: digits ?? 1 }).format(n);
    }
    case "percentRaw": {
      // value is already a percentage (25 → 25%)
      const n = toNum(v);
      return n === null ? String(v) : numberFormat(locale, { style: "percent", minimumFractionDigits: digits ?? 1, maximumFractionDigits: digits ?? 1 }).format(n / 100);
    }
    case "date": {
      const d = toDate(v);
      return d ? d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : String(v);
    }
    case "datetime": {
      const d = toDate(v);
      return d ? d.toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : String(v);
    }
    case "month": {
      const d = toDate(String(v).length === 7 ? `${v}-01` : v);
      return d ? d.toLocaleDateString(locale, { year: "numeric", month: "short" }) : String(v);
    }
    case "quarter": {
      const d = toDate(v);
      return d ? `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}` : String(v);
    }
    case "year": {
      const d = toDate(v);
      return d ? String(d.getFullYear()) : String(v);
    }
    case "text":
      return String(v);
    default:
      return String(v);
  }
}

/** Formatters keyed by name for {{ value | name:arg }} bindings. */
export function bindingFormatters(opts: FormatOptions = {}) {
  const names = ["number", "integer", "decimal", "currency", "percent", "percentRaw", "compact", "compactCurrency", "date", "datetime", "month", "quarter", "year", "text"];
  const out: Record<string, (v: unknown, arg?: string) => string> = {};
  for (const n of names) out[n] = (v, arg) => formatValue(v, arg ? `${n}:${arg}` : n, opts);
  return out;
}
