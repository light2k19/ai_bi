/**
 * End-to-end AI agent test against a running server and the configured AI provider:
 * a builder asks for a page from an empty draft; prints tool activity; checks the final draft
 * validates and saves. Usage: npx tsx tools/ai-smoke.ts "<request>" [baseUrl]
 */
const request = process.argv[2] ?? "Build a regional sales review: total revenue, margin % and order count KPIs, a monthly revenue trend for the last 12 months by region, revenue by product category, and a table of the top 10 customers by revenue. Add a region filter.";
const base = process.argv[3] ?? "http://127.0.0.1:8787";
let cookie = "";

async function api(path: string, json?: unknown) {
  const r = await fetch(base + path, { method: json === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return r;
}

await api("/api/auth/login", { email: "builder@example.com", password: "builder1234" });
const draft = { page: { id: "pg_ai_smoke", title: "Untitled page" }, components: {}, scripts: {}, assets: {} };
const started = Date.now();
const res = await api("/api/projects/demo/ai/chat", { message: request, draft });
if (!res.ok || !res.body) {
  console.error("chat failed", res.status, await res.text());
  process.exit(1);
}
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let final: { draft?: { page: { widgets: unknown[]; datasets: unknown[]; title: string } }; text?: string } = {};
let validation: { errors: { path: string; message: string }[]; warnings: unknown[] } | null = null;
let tools = 0;
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
    const t = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
    if (e.type === "tool_start") {
      tools++;
      console.log(`${t}s  → ${e.name} ${e.args.replace(/\s+/g, " ").slice(0, 150)}`);
    } else if (e.type === "tool_end") console.log(`${t}s  ${e.ok ? "✓" : "✗"} ${e.name}: ${e.result.replace(/\s+/g, " ").slice(0, 200)}`);
    else if (e.type === "validation") validation = e;
    else if (e.type === "usage") console.log(`${t}s  usage`, JSON.stringify(e.usage));
    else if (e.type === "error") console.log(`${t}s  ERROR ${e.message}`);
    else if (e.type === "done") final = e;
  }
}
console.log("\n--- assistant ---\n" + (final.text ?? "").slice(0, 1500));
const p = final.draft?.page;
console.log(`\n${tools} tool calls; page "${p?.title}" with ${p?.datasets.length ?? 0} datasets, ${p?.widgets.length ?? 0} widgets; validation errors: ${validation?.errors.length ?? "?"}`);
for (const e of validation?.errors ?? []) console.log("  ERROR", e.path, e.message);
if (final.draft && validation && !validation.errors.length) {
  const s = await api("/api/projects/demo/pages", { bundle: final.draft, source: "ai", message: "AI smoke test" });
  console.log("save:", s.status, (await s.text()).slice(0, 300));
}
process.exit(validation && !validation.errors.length ? 0 : 1);
