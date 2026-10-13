/**
 * AI page-builder evaluation against the demo project (costs real model tokens).
 * Usage: npx tsx tools/ai-eval.ts [baseUrl] [--only=id,id] [--concurrency=2]
 * Each case: empty draft + request → agent turn → grade the final draft:
 *   valid      no validation errors and every dataset loads (server-reported)
 *   widgets    required widget types present and minimum widget count
 *   features   required interactions / scripts / filters present
 *   golden     some numeric value on the page is within 1% of a golden SQL total (catches fan-out joins)
 */
import { PageBundle, defaultFilterValues } from "@aibi/page-spec";
import { runPipeline, toFrame, type Frame, type QueryResult } from "@aibi/transforms";

const base = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787";
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const concurrency = Number(process.argv.find((a) => a.startsWith("--concurrency="))?.slice(14) ?? 2);

interface Case {
  id: string;
  prompt: string;
  types?: string[][]; // each inner list: at least one of these types must be present
  minWidgets?: number;
  features?: ("interaction" | "script" | "filter")[];
  golden?: { sql: string; label: string };
}

const YTD = "order_date >= strftime('%Y', 'now') || '-01-01'";
const CASES: Case[] = [
  {
    id: "sales-overview",
    prompt: "Build a sales overview for this year: KPIs for revenue, gross margin % and orders versus last year, a monthly revenue trend, revenue by region and by channel, and the top 10 products.",
    types: [["kpi", "kpiRow"], ["echarts.line", "echarts.area", "echarts.combo"], ["echarts.bar", "echarts.pie"]],
    minWidgets: 5,
    golden: { label: "revenue YTD", sql: `SELECT SUM(revenue) v FROM v_sales WHERE status = 'Completed' AND ${YTD}` },
  },
  {
    id: "headcount",
    prompt: "Show headcount: current FTE by department, the FTE trend over the last 12 months by department, and monthly salary cost.",
    types: [["echarts.bar", "echarts.pie", "table", "kpi", "kpiRow"], ["echarts.line", "echarts.area", "echarts.combo"]],
    minWidgets: 2,
    golden: { label: "latest total FTE", sql: "SELECT SUM(fte) v FROM headcount WHERE month = (SELECT MAX(month) FROM headcount)" },
  },
  {
    id: "top-customers",
    prompt: "A table of the top 20 customers by revenue this year with segment, country, orders, revenue and margin %, with data bars on revenue.",
    types: [["table"]],
    minWidgets: 1,
  },
  {
    id: "channel-mix",
    prompt: "Show this year's revenue mix by sales channel as a donut chart and a KPI for total revenue.",
    types: [["echarts.pie"], ["kpi", "kpiRow", "text"]],
    minWidgets: 2,
    golden: { label: "revenue YTD", sql: `SELECT SUM(revenue) v FROM v_sales WHERE status = 'Completed' AND ${YTD}` },
  },
  {
    id: "budget-waterfall",
    prompt: "For this year, show a waterfall bridge from total budgeted opex to actual opex by department, and a table with budget, actual and variance per department.",
    types: [["echarts.waterfall"], ["table", "pivot"]],
    minWidgets: 2,
  },
  {
    id: "region-drill",
    prompt: "Revenue by region as a bar chart for the last 12 months; clicking a region should filter the page, and a table below shows that region's top products.",
    types: [["echarts.bar"], ["table"]],
    features: ["interaction", "filter"],
    minWidgets: 2,
  },
  {
    id: "animated",
    prompt: "Build a KPI row for revenue, orders and margin this year and add a page script that counts the KPIs up and reveals the widgets one by one.",
    types: [["kpi", "kpiRow"]],
    features: ["script"],
    minWidgets: 1,
  },
  {
    id: "pnl",
    prompt: "Monthly P&L for the last 12 months: revenue, COGS and opex as positive amounts, and gross margin %, as a chart and a table.",
    types: [["echarts.bar", "echarts.line", "echarts.combo", "echarts.area"], ["table", "pivot"]],
    minWidgets: 2,
  },
];

let cookie = "";
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

async function turn(prompt: string) {
  const res = await fetch(`${base}/api/projects/demo/ai/chat`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: prompt, draft: { page: { id: `pg_eval_${Math.random().toString(36).slice(2, 8)}`, title: "Untitled page" } } }) });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let draft: PageBundle | null = null;
  let errors: { path: string; message: string }[] = [];
  let cost = 0;
  let tools = 0;
  let error = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith("data:")) continue;
      const e = JSON.parse(chunk.slice(5));
      if (e.type === "done") draft = e.draft;
      if (e.type === "validation") errors = e.errors;
      if (e.type === "usage") cost = e.usage.cost ?? 0;
      if (e.type === "tool_start") tools++;
      if (e.type === "error") error = e.message;
    }
  }
  return { draft, errors, cost, tools, error };
}

async function frames(b: PageBundle): Promise<Record<string, Frame>> {
  const filters = defaultFilterValues(b.page.filters);
  const out: Record<string, Frame> = {};
  for (let pass = 0; pass < 3; pass++)
    for (const d of b.page.datasets) {
      if (out[d.id]) continue;
      try {
        let f: Frame | undefined;
        if (d.source && d.request) f = toFrame(await api<QueryResult>("/api/projects/demo/query/adhoc", { source: d.source, request: d.request, filters, maxRows: 5000 }));
        else if (d.from?.length) f = out[d.from[0]];
        if (!f) continue;
        out[d.id] = runPipeline(f, d.pipeline as never, { datasets: out, vars: { filters, page: { id: b.page.id } } });
      } catch {
        /* graded via validation errors */
      }
    }
  return out;
}

async function grade(c: Case) {
  const t0 = Date.now();
  const r = await turn(c.prompt);
  const secs = Math.round((Date.now() - t0) / 1000);
  if (!r.draft) return { id: c.id, secs, cost: r.cost, tools: r.tools, score: 0, notes: [r.error || "no draft"] };
  const b = PageBundle.parse(r.draft);
  const notes: string[] = [];
  const checks: boolean[] = [];
  const valid = r.errors.length === 0;
  checks.push(valid);
  if (!valid) notes.push(`${r.errors.length} errors: ${r.errors.slice(0, 2).map((e) => e.message).join("; ")}`);
  const types = new Set(b.page.widgets.map((w) => w.type));
  for (const alt of c.types ?? []) {
    const ok = alt.some((t) => types.has(t));
    checks.push(ok);
    if (!ok) notes.push(`missing one of ${alt.join("/")}`);
  }
  const enough = b.page.widgets.length >= (c.minWidgets ?? 1);
  checks.push(enough);
  if (!enough) notes.push(`only ${b.page.widgets.length} widgets`);
  for (const f of c.features ?? []) {
    const ok = f === "interaction" ? b.page.widgets.some((w) => w.interactions?.some((i) => i.action === "setFilter")) : f === "script" ? b.page.scripts.length > 0 : b.page.filters.length > 0;
    checks.push(ok);
    if (!ok) notes.push(`missing ${f}`);
  }
  if (c.golden) {
    const g = await api<QueryResult>("/api/projects/demo/query/adhoc", { source: "sales", request: { sql: c.golden.sql } });
    const want = Number(g.rows[0][0]);
    const fr = await frames(b);
    const nums = Object.values(fr).flatMap((f) => f.rows.flatMap((row) => Object.values(row))).filter((v): v is number => typeof v === "number");
    const ok = nums.some((n) => Math.abs(n - want) <= Math.abs(want) * 0.01);
    checks.push(ok);
    if (!ok) notes.push(`no value ≈ ${c.golden.label} ${Math.round(want).toLocaleString()}`);
  }
  const score = checks.filter(Boolean).length / checks.length;
  if (r.error) notes.push(`stream error: ${r.error}`);
  return { id: c.id, secs, cost: r.cost, tools: r.tools, score, notes, widgets: b.page.widgets.length };
}

await api("/api/auth/login", { email: "builder@example.com", password: "builder1234" });
const cases = CASES.filter((c) => !only || only.includes(c.id));
const results: Awaited<ReturnType<typeof grade>>[] = [];
const queue = [...cases];
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const r = await grade(c).catch((e) => ({ id: c!.id, secs: 0, cost: 0, tools: 0, score: 0, notes: [(e as Error).message] }));
      results.push(r);
      console.log(`${r.score === 1 ? "PASS" : r.score >= 0.5 ? "PART" : "FAIL"} ${r.id.padEnd(18)} score ${(r.score * 100).toFixed(0).padStart(3)}%  ${String(r.secs).padStart(3)}s  ${String(r.tools).padStart(2)} tools  $${r.cost.toFixed(4)}  ${r.notes.join(" | ")}`);
    }
  }),
);
const avg = results.reduce((s, r) => s + r.score, 0) / results.length;
const cost = results.reduce((s, r) => s + r.cost, 0);
console.log(`\n${results.length} cases · mean score ${(avg * 100).toFixed(0)}% · ${results.filter((r) => r.score === 1).length} fully passed · total cost $${cost.toFixed(3)}`);
