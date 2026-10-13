import { compileExpr, evalNode, resolveBindings, type JsonSchema, type TransformInfo, addDays, addMonths } from "@aibi/page-spec";
import { type Frame, type Column, inferColumns } from "./frame";

export interface TransformContext {
  /** other datasets already computed, by id (for join / union / periodCompare) */
  datasets: Record<string, Frame | undefined>;
  /** extra variables for expressions and {{ }} bindings in steps, e.g. { filters, page } */
  vars?: Record<string, unknown>;
}

type Step = Record<string, unknown> & { op: string };

interface TransformDef {
  description: string;
  schema: JsonSchema;
  example: Record<string, unknown>;
  run(f: Frame, step: Step, ctx: TransformContext): Frame;
}

const str: JsonSchema = { type: "string" };
const strArr: JsonSchema = { type: "array", items: { type: "string" } };
const strOrArr: JsonSchema = { anyOf: [str, strArr] };
const AGG_OPS = ["sum", "avg", "min", "max", "count", "countDistinct", "first", "last", "median"] as const;
type AggOp = (typeof AGG_OPS)[number];

const asArr = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? (v as string[]) : [String(v)]);
const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));

function need(f: Frame, cols: string[], op: string) {
  const have = new Set(f.columns.map((c) => c.name));
  for (const c of cols) if (!have.has(c)) throw new Error(`${op}: column '${c}' not found (columns: ${[...have].join(", ")})`);
}

function aggregate(values: unknown[], op: AggOp): unknown {
  const nums = () => values.map(num).filter(Number.isFinite);
  switch (op) {
    case "sum":
      return nums().reduce((a, b) => a + b, 0);
    case "avg": {
      const n = nums();
      return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
    }
    case "min": {
      const n = nums();
      return n.length ? Math.min(...n) : null;
    }
    case "max": {
      const n = nums();
      return n.length ? Math.max(...n) : null;
    }
    case "count":
      return values.filter((v) => v !== null && v !== undefined).length;
    case "countDistinct":
      return new Set(values.filter((v) => v !== null && v !== undefined).map(String)).size;
    case "first":
      return values[0] ?? null;
    case "last":
      return values[values.length - 1] ?? null;
    case "median": {
      const n = nums().sort((a, b) => a - b);
      if (!n.length) return null;
      const m = Math.floor(n.length / 2);
      return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
    }
  }
}

function groupBy(rows: Record<string, unknown>[], keys: string[]) {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = JSON.stringify(keys.map((c) => r[c] ?? null));
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r);
  }
  return groups;
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a !== "string" || typeof b !== "string") if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function withColumns(f: Frame, rows: Record<string, unknown>[], extra: string[]): Frame {
  const names = [...f.columns.map((c) => c.name), ...extra.filter((e) => !f.columns.some((c) => c.name === e))];
  const keep = new Map(f.columns.map((c) => [c.name, c]));
  const inferred = inferColumns(rows, names);
  return { ...f, rows, columns: names.map((n, i) => (keep.has(n) && !extra.includes(n) ? keep.get(n)! : inferred[i])) };
}

function bucket(v: unknown, unit: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  const d = s.slice(0, 10);
  const [y, m] = d.split("-").map(Number);
  switch (unit) {
    case "year":
      return `${y}`;
    case "quarter":
      return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case "month":
      return d.slice(0, 7);
    case "week": {
      const dt = new Date(`${d}T00:00:00Z`);
      const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
      dt.setUTCDate(dt.getUTCDate() - dow);
      return dt.toISOString().slice(0, 10);
    }
    default:
      return d;
  }
}

function nextBucket(b: string, unit: string): string {
  switch (unit) {
    case "year":
      return String(Number(b) + 1);
    case "quarter": {
      const [y, q] = b.split("-Q").map(Number);
      return q === 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
    }
    case "month":
      return addMonths(`${b}-01`, 1).slice(0, 7);
    case "week":
      return addDays(b, 7);
    default:
      return addDays(b, 1);
  }
}

function shiftBucket(b: string, unit: string, n: number): string {
  let out = b;
  if (n >= 0) for (let i = 0; i < n; i++) out = nextBucket(out, unit);
  else {
    switch (unit) {
      case "year":
        return String(Number(b) + n);
      case "quarter": {
        const [y, q] = b.split("-Q").map(Number);
        const idx = y * 4 + (q - 1) + n;
        return `${Math.floor(idx / 4)}-Q${(idx % 4) + 1}`;
      }
      case "month":
        return addMonths(`${b}-01`, n).slice(0, 7);
      case "week":
        return addDays(b, 7 * n);
      default:
        return addDays(b, n);
    }
  }
  return out;
}

export const TRANSFORMS: Record<string, TransformDef> = {
  calc: {
    description:
      "Add or replace columns computed by expressions over each row. Expressions use column names (row['Name with spaces'] for names that are not identifiers), + - * / %, comparisons, ?:, and functions like round(x,2), safeDiv(a,b), coalesce(a,b), if(c,a,b), year(d), month(d). Alias SQL columns without spaces to keep expressions simple.",
    schema: { type: "object", required: ["op", "columns"], properties: { op: str, columns: { type: "object", additionalProperties: str } } },
    example: { op: "calc", columns: { variance: "revenue - target", attainment: "safeDiv(revenue, target)" } },
    run(f, step, ctx) {
      const cols = step.columns as Record<string, string>;
      const compiled = Object.entries(cols).map(([k, e]) => [k, compileExpr(e)] as const);
      const rows = f.rows.map((r, index) => {
        const o = { ...r };
        for (const [k, node] of compiled) o[k] = evalNode(node, { ...(ctx.vars ?? {}), ...o, row: o, index });
        return o;
      });
      return withColumns(f, rows, Object.keys(cols));
    },
  },
  filter: {
    description: "Keep rows where the expression is true.",
    schema: { type: "object", required: ["op", "where"], properties: { op: str, where: str } },
    example: { op: "filter", where: "revenue > 0 && region != 'Internal'" },
    run(f, step, ctx) {
      const node = compileExpr(String(step.where));
      return { ...f, rows: f.rows.filter((r, index) => Boolean(evalNode(node, { ...(ctx.vars ?? {}), ...r, row: r, index }))) };
    },
  },
  sort: {
    description: "Sort rows by one or more columns.",
    schema: {
      type: "object",
      required: ["op", "by"],
      properties: {
        op: str,
        by: { anyOf: [str, { type: "array", items: { anyOf: [str, { type: "object", properties: { column: str, desc: { type: "boolean" } }, required: ["column"] }] } }] },
        desc: { type: "boolean" },
      },
    },
    example: { op: "sort", by: [{ column: "revenue", desc: true }] },
    run(f, step) {
      const by = (Array.isArray(step.by) ? step.by : [step.by]).map((b) =>
        typeof b === "string" ? { column: b, desc: Boolean(step.desc) } : (b as { column: string; desc?: boolean }),
      );
      need(f, by.map((b) => b.column), "sort");
      const rows = [...f.rows].sort((a, b) => {
        for (const k of by) {
          const c = cmp(a[k.column], b[k.column]);
          if (c !== 0) return k.desc ? -c : c;
        }
        return 0;
      });
      return { ...f, rows };
    },
  },
  select: {
    description: "Keep (and order) a subset of columns, optionally renaming them.",
    schema: { type: "object", required: ["op"], properties: { op: str, columns: strArr, rename: { type: "object", additionalProperties: str } } },
    example: { op: "select", columns: ["region", "revenue"], rename: { revenue: "Revenue" } },
    run(f, step) {
      const cols = step.columns ? asArr(step.columns) : f.columns.map((c) => c.name);
      need(f, cols, "select");
      const rename = (step.rename ?? {}) as Record<string, string>;
      const rows = f.rows.map((r) => {
        const o: Record<string, unknown> = {};
        for (const c of cols) o[rename[c] ?? c] = r[c];
        return o;
      });
      const byName = new Map(f.columns.map((c) => [c.name, c]));
      return { ...f, rows, columns: cols.map((c) => ({ ...byName.get(c)!, name: rename[c] ?? c })) };
    },
  },
  aggregate: {
    description: `Group rows and aggregate. measures maps output column → { op, column } with op in ${AGG_OPS.join(", ")}. Shorthand "sum(amount)" is accepted.`,
    schema: {
      type: "object",
      required: ["op", "measures"],
      properties: {
        op: str,
        groupBy: strOrArr,
        measures: { type: "object", additionalProperties: { anyOf: [str, { type: "object", properties: { op: { type: "string", enum: [...AGG_OPS] }, column: str }, required: ["op"] }] } },
      },
    },
    example: { op: "aggregate", groupBy: ["region"], measures: { revenue: { op: "sum", column: "amount" }, orders: "count(id)" } },
    run(f, step) {
      const keys = asArr(step.groupBy);
      need(f, keys, "aggregate");
      const measures = Object.entries(step.measures as Record<string, unknown>).map(([name, m]) => {
        if (typeof m === "string") {
          const mm = /^\s*(\w+)\s*\(\s*([^)]*)\s*\)\s*$/.exec(m);
          if (!mm) throw new Error(`aggregate: cannot parse measure '${m}'`);
          return { name, op: mm[1] as AggOp, column: mm[2] || undefined };
        }
        const o = m as { op: AggOp; column?: string };
        return { name, op: o.op, column: o.column };
      });
      for (const m of measures) {
        if (!AGG_OPS.includes(m.op)) throw new Error(`aggregate: unknown op '${m.op}'`);
        if (m.column && m.column !== "*") need(f, [m.column], "aggregate");
      }
      const rows: Record<string, unknown>[] = [];
      for (const g of groupBy(f.rows, keys).values()) {
        const o: Record<string, unknown> = {};
        for (const k of keys) o[k] = g[0][k];
        for (const m of measures) o[m.name] = aggregate(m.column && m.column !== "*" ? g.map((r) => r[m.column!]) : g.map(() => 1), m.op);
        rows.push(o);
      }
      const keyCols = f.columns.filter((c) => keys.includes(c.name));
      const ordered = keys.map((k) => keyCols.find((c) => c.name === k)!);
      return { ...f, rows, columns: [...ordered, ...measures.map((m) => ({ name: m.name, type: (m.op === "first" || m.op === "last" ? f.columns.find((c) => c.name === m.column)?.type : "number") ?? "number" }) as Column)] };
    },
  },
  pivot: {
    description: "Turn distinct values of `column` into columns, aggregating `value` (wide format, e.g. months as columns).",
    schema: {
      type: "object",
      required: ["op", "index", "column", "value"],
      properties: { op: str, index: strOrArr, column: str, value: str, agg: { type: "string", enum: [...AGG_OPS] }, fill: {}, sortColumns: { type: "boolean" } },
    },
    example: { op: "pivot", index: ["region"], column: "month", value: "revenue", agg: "sum", fill: 0 },
    run(f, step) {
      const index = asArr(step.index);
      const col = String(step.column);
      const val = String(step.value);
      need(f, [...index, col, val], "pivot");
      const agg = (step.agg as AggOp) ?? "sum";
      let pivCols = [...new Set(f.rows.map((r) => String(r[col] ?? "")))];
      if (step.sortColumns !== false) pivCols = pivCols.sort((a, b) => cmp(a, b));
      const rows: Record<string, unknown>[] = [];
      for (const g of groupBy(f.rows, index).values()) {
        const o: Record<string, unknown> = {};
        for (const k of index) o[k] = g[0][k];
        for (const pc of pivCols) {
          const vals = g.filter((r) => String(r[col] ?? "") === pc).map((r) => r[val]);
          o[pc] = vals.length ? aggregate(vals, agg) : (step.fill ?? null);
        }
        rows.push(o);
      }
      return { ...f, rows, columns: [...f.columns.filter((c) => index.includes(c.name)), ...pivCols.map((p) => ({ name: p, type: "number" as const }))] };
    },
  },
  unpivot: {
    description: "Turn columns into rows (long format): each listed column becomes a row with name and value.",
    schema: { type: "object", required: ["op", "columns"], properties: { op: str, keep: strArr, columns: strArr, nameAs: str, valueAs: str } },
    example: { op: "unpivot", keep: ["region"], columns: ["q1", "q2", "q3", "q4"], nameAs: "quarter", valueAs: "revenue" },
    run(f, step) {
      const cols = asArr(step.columns);
      const keep = step.keep ? asArr(step.keep) : f.columns.map((c) => c.name).filter((c) => !cols.includes(c));
      const nameAs = String(step.nameAs ?? "name");
      const valueAs = String(step.valueAs ?? "value");
      need(f, [...cols, ...keep], "unpivot");
      const rows: Record<string, unknown>[] = [];
      for (const r of f.rows) for (const c of cols) {
        const o: Record<string, unknown> = {};
        for (const k of keep) o[k] = r[k];
        o[nameAs] = c;
        o[valueAs] = r[c];
        rows.push(o);
      }
      return { ...f, rows, columns: [...f.columns.filter((c) => keep.includes(c.name)), { name: nameAs, type: "string" }, ...inferColumns(rows, [valueAs])] };
    },
  },
  join: {
    description: "Join another dataset (`with`) on key columns. type: inner | left | right | full. Clashing right-side columns get `prefix`.",
    schema: {
      type: "object",
      required: ["op", "with", "on"],
      properties: {
        op: str,
        with: str,
        on: { anyOf: [str, strArr, { type: "array", items: { type: "object", properties: { left: str, right: str }, required: ["left", "right"] } }] },
        type: { type: "string", enum: ["inner", "left", "right", "full"] },
        prefix: str,
        columns: strArr,
      },
    },
    example: { op: "join", with: "targets", on: ["region"], type: "left" },
    run(f, step, ctx) {
      const other = ctx.datasets[String(step.with)];
      if (!other) throw new Error(`join: dataset '${String(step.with)}' is not available`);
      const pairs = (Array.isArray(step.on) ? step.on : [step.on]).map((o) => (typeof o === "string" ? { left: o, right: o } : (o as { left: string; right: string })));
      need(f, pairs.map((p) => p.left), "join");
      need(other, pairs.map((p) => p.right), "join (right side)");
      const type = (step.type as string) ?? "left";
      const prefix = String(step.prefix ?? `${String(step.with)}_`);
      const rightCols = (step.columns ? asArr(step.columns) : other.columns.map((c) => c.name)).filter((c) => !pairs.some((p) => p.right === c && p.left === c));
      const leftNames = new Set(f.columns.map((c) => c.name));
      const outName = (c: string) => (leftNames.has(c) ? `${prefix}${c}` : c);
      const index = new Map<string, Record<string, unknown>[]>();
      for (const r of other.rows) {
        const k = JSON.stringify(pairs.map((p) => String(r[p.right] ?? "")));
        let a = index.get(k);
        if (!a) index.set(k, (a = []));
        a.push(r);
      }
      const rows: Record<string, unknown>[] = [];
      const matched = new Set<Record<string, unknown>>();
      for (const l of f.rows) {
        const k = JSON.stringify(pairs.map((p) => String(l[p.left] ?? "")));
        const ms = index.get(k);
        if (ms?.length) {
          for (const m of ms) {
            matched.add(m);
            const o = { ...l };
            for (const c of rightCols) o[outName(c)] = m[c];
            rows.push(o);
          }
        } else if (type === "left" || type === "full") {
          const o = { ...l };
          for (const c of rightCols) o[outName(c)] = null;
          rows.push(o);
        }
      }
      if (type === "right" || type === "full") {
        for (const m of other.rows) {
          if (matched.has(m)) continue;
          const o: Record<string, unknown> = {};
          for (const c of f.columns) o[c.name] = null;
          for (const p of pairs) o[p.left] = m[p.right];
          for (const c of rightCols) o[outName(c)] = m[c];
          rows.push(o);
        }
      }
      const rightColumnDefs = rightCols.map((c) => ({ ...(other.columns.find((x) => x.name === c) ?? { type: "string" as const }), name: outName(c) }));
      return { ...f, rows, columns: [...f.columns, ...rightColumnDefs] };
    },
  },
  union: {
    description: "Append the rows of another dataset (`with`). Columns are matched by name.",
    schema: { type: "object", required: ["op", "with"], properties: { op: str, with: str } },
    example: { op: "union", with: "other_region_sales" },
    run(f, step, ctx) {
      const other = ctx.datasets[String(step.with)];
      if (!other) throw new Error(`union: dataset '${String(step.with)}' is not available`);
      const names = [...new Set([...f.columns.map((c) => c.name), ...other.columns.map((c) => c.name)])];
      const rows = [...f.rows, ...other.rows].map((r) => Object.fromEntries(names.map((n) => [n, r[n] ?? null])));
      return { ...f, rows, columns: names.map((n) => f.columns.find((c) => c.name === n) ?? other.columns.find((c) => c.name === n)!) };
    },
  },
  topN: {
    description: "Keep the top N rows by a column; optionally collapse the rest into one 'Other' row (sums numeric columns).",
    schema: { type: "object", required: ["op", "n", "by"], properties: { op: str, n: { type: "integer", minimum: 1 }, by: str, asc: { type: "boolean" }, otherLabel: str, labelColumn: str } },
    example: { op: "topN", n: 5, by: "revenue", otherLabel: "Other", labelColumn: "region" },
    run(f, step) {
      const by = String(step.by);
      need(f, [by], "topN");
      const sorted = [...f.rows].sort((a, b) => (step.asc ? 1 : -1) * cmp(a[by], b[by]));
      const n = Number(step.n);
      const top = sorted.slice(0, n);
      const rest = sorted.slice(n);
      if (step.otherLabel && rest.length) {
        const label = String(step.labelColumn ?? f.columns.find((c) => c.type === "string")?.name ?? by);
        const other: Record<string, unknown> = {};
        for (const c of f.columns) other[c.name] = c.type === "number" ? rest.reduce((s, r) => s + (Number.isFinite(num(r[c.name])) ? num(r[c.name]) : 0), 0) : null;
        other[label] = step.otherLabel;
        top.push(other);
      }
      return { ...f, rows: top };
    },
  },
  rank: {
    description: "Add a rank column (1 = highest by default), optionally within partitions.",
    schema: { type: "object", required: ["op", "by"], properties: { op: str, by: str, as: str, asc: { type: "boolean" }, partitionBy: strOrArr } },
    example: { op: "rank", by: "revenue", as: "rank" },
    run(f, step) {
      const by = String(step.by);
      const as = String(step.as ?? "rank");
      const parts = asArr(step.partitionBy);
      need(f, [by, ...parts], "rank");
      const rows = f.rows.map((r) => ({ ...r }));
      for (const g of groupBy(rows, parts).values()) {
        const s = [...g].sort((a, b) => (step.asc ? 1 : -1) * cmp(a[by], b[by]));
        let rank = 0;
        let prev: unknown = Symbol();
        s.forEach((r, i) => {
          if (r[by] !== prev) rank = i + 1;
          prev = r[by];
          r[as] = rank;
        });
      }
      return withColumns(f, rows, [as]);
    },
  },
  dateTrunc: {
    description: "Bucket a date column to day | week | month | quarter | year (writes YYYY-MM-DD, YYYY-MM, YYYY-Qn or YYYY).",
    schema: { type: "object", required: ["op", "column", "unit"], properties: { op: str, column: str, unit: { type: "string", enum: ["day", "week", "month", "quarter", "year"] }, as: str } },
    example: { op: "dateTrunc", column: "sold_at", unit: "month", as: "month" },
    run(f, step) {
      const col = String(step.column);
      need(f, [col], "dateTrunc");
      const as = String(step.as ?? col);
      const rows = f.rows.map((r) => ({ ...r, [as]: bucket(r[col], String(step.unit)) }));
      const out = withColumns(f, rows, [as]);
      out.columns = out.columns.map((c) => (c.name === as ? { name: as, type: step.unit === "day" || step.unit === "week" ? "date" : "string" } : c));
      return out;
    },
  },
  fillGaps: {
    description:
      "Insert missing time buckets (day/week/month/quarter/year) so lines and bars have no holes; numeric columns get `fill`. Gaps are filled per series: `groupBy` names the series columns (default: the other text columns, e.g. region). Existing rows are never dropped.",
    schema: {
      type: "object",
      required: ["op", "column", "unit"],
      properties: { op: str, column: str, unit: { type: "string", enum: ["day", "week", "month", "quarter", "year"] }, fill: {}, start: str, end: str, groupBy: strOrArr },
    },
    example: { op: "fillGaps", column: "month", unit: "month", fill: 0 },
    run(f, step) {
      const col = String(step.column);
      const unit = String(step.unit);
      // series to fill separately: the given groupBy, else the other text columns (one line per region, …) unless
      // that would mean very many series; existing rows are kept either way
      const inferred = f.columns.filter((c) => c.name !== col && c.type !== "number").map((c) => c.name);
      const parts = step.groupBy !== undefined ? asArr(step.groupBy) : groupBy(f.rows, inferred).size <= 50 ? inferred : [];
      need(f, [col, ...parts], "fillGaps");
      const fill = step.fill ?? 0;
      const all = f.rows.map((r) => bucket(r[col], unit)).filter((x): x is string => !!x).sort();
      if (!all.length) return f;
      const start = step.start ? bucket(step.start, unit)! : all[0];
      const end = step.end ? bucket(step.end, unit)! : all[all.length - 1];
      const buckets: string[] = [];
      for (let b = start, guard = 0; b <= end && guard < 5000; b = nextBucket(b, unit), guard++) buckets.push(b);
      const numericCols = f.columns.filter((c) => c.type === "number" && !parts.includes(c.name)).map((c) => c.name);
      const rows: Record<string, unknown>[] = [];
      for (const g of groupBy(f.rows, parts).values()) {
        const byBucket = new Map<string, Record<string, unknown>[]>();
        for (const r of g) {
          const b = bucket(r[col], unit);
          if (!b) continue;
          let list = byBucket.get(b);
          if (!list) byBucket.set(b, (list = []));
          list.push(r);
        }
        for (const b of buckets) {
          const found = byBucket.get(b);
          if (found) for (const r of found) rows.push({ ...r, [col]: b });
          else {
            const o: Record<string, unknown> = { [col]: b };
            for (const p of parts) o[p] = g[0][p];
            for (const c of f.columns) if (!(c.name in o)) o[c.name] = numericCols.includes(c.name) ? fill : null;
            rows.push(o);
          }
        }
        // rows outside the bucket range or without a usable date are kept as they are
        for (const r of g) {
          const b = bucket(r[col], unit);
          if (!b || b < start || b > end) rows.push(r);
        }
      }
      return { ...f, rows };
    },
  },
  periodCompare: {
    description:
      "Compare measures with a prior period. Either join a prior-period dataset (`with`, matched on `key` columns) or shift within this dataset by `shift` buckets of `unit` on `dateColumn`. Adds <prefix><m>, <m>_delta and <m>_pct (ratio) for each measure. A shift only finds values the dataset itself contains: a dataset limited to the selected period has no earlier rows, so its comparisons come out empty. For 'vs last year' totals (KPI cards) do not use this: compute last year in the same SQL with the date filter's lyStart/lyEndExclusive.",
    schema: {
      type: "object",
      required: ["op", "measures"],
      properties: {
        op: str,
        measures: strArr,
        with: str,
        key: strOrArr,
        dateColumn: str,
        unit: { type: "string", enum: ["day", "week", "month", "quarter", "year"] },
        shift: { type: "integer" },
        prefix: str,
      },
    },
    example: { op: "periodCompare", with: "revenue_last_year", key: ["region"], measures: ["revenue"], prefix: "ly_" },
    run(f, step, ctx) {
      const measures = asArr(step.measures);
      need(f, measures, "periodCompare");
      const prefix = String(step.prefix ?? "prev_");
      let lookup: (r: Record<string, unknown>) => Record<string, unknown> | undefined;
      if (step.with) {
        const other = ctx.datasets[String(step.with)];
        if (!other) throw new Error(`periodCompare: dataset '${String(step.with)}' is not available`);
        const key = asArr(step.key);
        const idx = new Map(other.rows.map((r) => [JSON.stringify(key.map((k) => String(r[k] ?? ""))), r]));
        lookup = (r) => idx.get(JSON.stringify(key.map((k) => String(r[k] ?? ""))));
      } else {
        const dc = String(step.dateColumn ?? "");
        const unit = String(step.unit ?? "month");
        const shift = Number(step.shift ?? (unit === "month" ? 12 : unit === "quarter" ? 4 : 1));
        need(f, [dc], "periodCompare");
        const parts = asArr(step.key).filter((k) => k !== dc);
        const idx = new Map(f.rows.map((r) => [JSON.stringify([bucket(r[dc], unit), ...parts.map((k) => String(r[k] ?? ""))]), r]));
        lookup = (r) => {
          const b = bucket(r[dc], unit);
          return b ? idx.get(JSON.stringify([shiftBucket(b, unit, -shift), ...parts.map((k) => String(r[k] ?? ""))])) : undefined;
        };
      }
      const added: string[] = [];
      for (const m of measures) added.push(`${prefix}${m}`, `${m}_delta`, `${m}_pct`);
      const rows = f.rows.map((r) => {
        const p = lookup(r);
        const o = { ...r };
        for (const m of measures) {
          const cur = num(r[m]);
          const prev = p ? num(p[m]) : NaN;
          o[`${prefix}${m}`] = Number.isFinite(prev) ? prev : null;
          o[`${m}_delta`] = Number.isFinite(cur) && Number.isFinite(prev) ? cur - prev : null;
          o[`${m}_pct`] = Number.isFinite(cur) && Number.isFinite(prev) && prev !== 0 ? (cur - prev) / Math.abs(prev) : null;
        }
        return o;
      });
      const out = withColumns(f, rows, added);
      out.columns = out.columns.map((c) => (added.includes(c.name) ? { ...c, type: "number" } : c));
      return out;
    },
  },
  cumulative: {
    description: "Running total of a column in current row order (sort first), optionally per partition.",
    schema: { type: "object", required: ["op", "column"], properties: { op: str, column: str, as: str, partitionBy: strOrArr } },
    example: { op: "cumulative", column: "revenue", as: "revenue_ytd" },
    run(f, step) {
      const col = String(step.column);
      const as = String(step.as ?? `${col}_cum`);
      const parts = asArr(step.partitionBy);
      need(f, [col, ...parts], "cumulative");
      const totals = new Map<string, number>();
      const rows = f.rows.map((r) => {
        const k = JSON.stringify(parts.map((p) => r[p]));
        const t = (totals.get(k) ?? 0) + (Number.isFinite(num(r[col])) ? num(r[col]) : 0);
        totals.set(k, t);
        return { ...r, [as]: t };
      });
      return withColumns(f, rows, [as]);
    },
  },
  percentOfTotal: {
    description: "Add a column with each row's share of the column total (ratio 0..1), optionally per partition.",
    schema: { type: "object", required: ["op", "column"], properties: { op: str, column: str, as: str, partitionBy: strOrArr } },
    example: { op: "percentOfTotal", column: "revenue", as: "share" },
    run(f, step) {
      const col = String(step.column);
      const as = String(step.as ?? `${col}_share`);
      const parts = asArr(step.partitionBy);
      need(f, [col, ...parts], "percentOfTotal");
      const totals = new Map<string, number>();
      for (const r of f.rows) {
        const k = JSON.stringify(parts.map((p) => r[p]));
        totals.set(k, (totals.get(k) ?? 0) + (Number.isFinite(num(r[col])) ? num(r[col]) : 0));
      }
      const rows = f.rows.map((r) => {
        const t = totals.get(JSON.stringify(parts.map((p) => r[p]))) ?? 0;
        return { ...r, [as]: t ? num(r[col]) / t : null };
      });
      return withColumns(f, rows, [as]);
    },
  },
  movingAverage: {
    description: "Trailing moving average over `window` rows in current order, optionally per partition.",
    schema: { type: "object", required: ["op", "column", "window"], properties: { op: str, column: str, window: { type: "integer", minimum: 1 }, as: str, partitionBy: strOrArr } },
    example: { op: "movingAverage", column: "revenue", window: 3, as: "revenue_ma3" },
    run(f, step) {
      const col = String(step.column);
      const w = Number(step.window);
      const as = String(step.as ?? `${col}_ma${w}`);
      const parts = asArr(step.partitionBy);
      need(f, [col, ...parts], "movingAverage");
      const hist = new Map<string, number[]>();
      const rows = f.rows.map((r) => {
        const k = JSON.stringify(parts.map((p) => r[p]));
        const h = hist.get(k) ?? [];
        h.push(num(r[col]));
        if (h.length > w) h.shift();
        hist.set(k, h);
        const v = h.filter(Number.isFinite);
        return { ...r, [as]: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null };
      });
      return withColumns(f, rows, [as]);
    },
  },
  limit: {
    description: "Keep the first N rows.",
    schema: { type: "object", required: ["op", "n"], properties: { op: str, n: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 } } },
    example: { op: "limit", n: 10 },
    run(f, step) {
      const o = Number(step.offset ?? 0);
      return { ...f, rows: f.rows.slice(o, o + Number(step.n)) };
    },
  },
  distinct: {
    description: "Remove duplicate rows (by all columns or the listed ones).",
    schema: { type: "object", required: ["op"], properties: { op: str, columns: strArr } },
    example: { op: "distinct", columns: ["region"] },
    run(f, step) {
      const cols = step.columns ? asArr(step.columns) : f.columns.map((c) => c.name);
      const seen = new Set<string>();
      const rows = f.rows.filter((r) => {
        const k = JSON.stringify(cols.map((c) => r[c]));
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return step.columns ? { ...f, rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))), columns: f.columns.filter((c) => cols.includes(c.name)) } : { ...f, rows };
    },
  },
};

export function transformCatalogue(skill = "transform-core"): TransformInfo[] {
  return Object.entries(TRANSFORMS).map(([op, d]) => ({ op, skill, description: d.description, schema: d.schema, example: d.example }));
}

/** Apply a pipeline of steps to a frame. Throws with the failing step index on error. */
export function runPipeline(f: Frame, steps: Step[] | undefined, ctx: TransformContext): Frame {
  let cur = f;
  (steps ?? []).forEach((raw, i) => {
    const def = TRANSFORMS[raw.op];
    if (!def) throw new Error(`pipeline step ${i}: unknown transform '${raw.op}'`);
    try {
      // {{ }} bindings in steps (e.g. "month >= left('{{filters.date.start}}', 7)") resolve from ctx.vars
      const s = ctx.vars && JSON.stringify(raw).includes("{{") ? resolveBindings(raw, ctx.vars) : raw;
      cur = def.run(cur, s, ctx);
    } catch (e) {
      throw new Error(`pipeline step ${i} (${raw.op}): ${(e as Error).message}`);
    }
  });
  return cur;
}
