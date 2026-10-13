/**
 * API smoke test against a running server: sign in, load the demo page, run each dataset as a
 * viewer would (stored SQL + filter values), check the read-only guard, export a package and
 * re-import it. Usage: npx tsx tools/smoke.ts [baseUrl]
 */
import { defaultFilterValues, PageBundle } from "@aibi/page-spec";
import { runPipeline, toFrame, type Frame } from "@aibi/transforms";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
let cookie = "";
let failures = 0;

async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (cookie) headers.cookie = cookie;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return r;
}
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function login(email: string, password: string) {
  cookie = "";
  const r = await api("/api/auth/login", { method: "POST", json: { email, password } });
  check(`login ${email}`, r.ok, String(r.status));
}

await login("viewer@example.com", "viewer1234");
const me = await (await api("/api/auth/me")).json();
check("me lists demo project", me.projects?.some((p: { slug: string }) => p.slug === "demo"));

const page = await (await api("/api/projects/demo/pages/pg_demo_sales")).json();
check("viewer loads sample page", !!page.bundle?.page, page.meta?.title);
const bundle = PageBundle.parse(page.bundle);

// filter values as the runtime computes them (region options from region_list)
const regionList = await (await api("/api/projects/demo/query/dataset", { method: "POST", json: { pageId: "pg_demo_sales", datasetId: "region_list", filters: {} } })).json();
const options = { region: regionList.rows.map((r: unknown[]) => r[0]) };
const filters = defaultFilterValues(bundle.page.filters, {}, { options });
const frames: Record<string, Frame> = {};
for (const d of bundle.page.datasets) {
  const t = Date.now();
  const r = await api("/api/projects/demo/query/dataset", { method: "POST", json: { pageId: "pg_demo_sales", datasetId: d.id, filters } });
  const j = await r.json();
  if (!r.ok) {
    check(`dataset ${d.id}`, false, JSON.stringify(j));
    continue;
  }
  const f = runPipeline(toFrame(j), d.pipeline as never, { datasets: frames, vars: { filters, page: { id: bundle.page.id } } });
  frames[d.id] = f;
  check(`dataset ${d.id}`, f.rows.length > 0, `${f.rows.length} rows, ${Date.now() - t} ms, columns ${f.columns.map((c) => c.name).join(",")}`);
}
console.log("  kpis:", JSON.stringify(frames.kpis?.rows[0]));
console.log("  by_region:", JSON.stringify(frames.by_region?.rows.slice(0, 2)));
console.log("  trend:", JSON.stringify(frames.trend?.rows.slice(-2)));

// viewer may not run ad-hoc SQL
const adhocViewer = await api("/api/projects/demo/query/adhoc", { method: "POST", json: { source: "sales", request: { sql: "SELECT 1" } } });
check("viewer cannot run ad-hoc SQL", adhocViewer.status === 403, String(adhocViewer.status));

// builder: ad-hoc SQL and the read-only guard
await login("builder@example.com", "builder1234");
const okq = await api("/api/projects/demo/query/adhoc", { method: "POST", json: { source: "sales", request: { sql: "SELECT category, COUNT(*) n FROM products GROUP BY category" } } });
check("builder ad-hoc select", okq.ok, String(okq.status));
for (const sql of ["DELETE FROM orders", "SELECT 1; DROP TABLE orders", "UPDATE products SET list_price = 0", "ATTACH DATABASE 'x.db' AS x"]) {
  const r = await api("/api/projects/demo/query/adhoc", { method: "POST", json: { source: "sales", request: { sql } } });
  const j = await r.json();
  check(`guard rejects: ${sql}`, r.status === 400, j.error?.slice(0, 80));
}
const origin = await api("/api/projects/demo/query/adhoc", { method: "POST", json: { source: "sales", request: { sql: "SELECT 1" } }, headers: { origin: "http://evil.example" } });
check("cross-origin POST rejected", origin.status === 403, String(origin.status));

// export → re-import as a copy
const exp = await api("/api/projects/demo/pages/pg_demo_sales/export");
const buf = Buffer.from(await exp.arrayBuffer());
check("export .aibi", exp.ok && buf.length > 1000, `${buf.length} bytes`);
const fd = new FormData();
fd.append("file", new Blob([buf]), "sales.aibi");
const an = await api("/api/projects/demo/import/analyze", { method: "POST", body: fd });
const rep = await an.json();
check("import analyze", an.ok && rep.errors?.length === 0, `modes ${rep.modes}, sources ${rep.sources?.map((s: { alias: string; suggested: string }) => `${s.alias}->${s.suggested}`)}, errors ${JSON.stringify(rep.errors)}`);
if (an.ok) {
  const c = await api(`/api/projects/demo/import/${rep.importId}/commit`, { method: "POST", json: { mode: "copy", mapping: {}, title: "Sales performance (imported copy)" } });
  const cj = await c.json();
  check("import commit as copy", c.ok, JSON.stringify(cj).slice(0, 120));
  if (c.ok) {
    const del = await api(`/api/projects/demo/pages/${cj.id}`, { method: "DELETE", headers: { origin: base } }); // leave no test artifacts
    check("delete imported copy", del.ok, String(del.status));
  }
}

// validation endpoint catches problems
const bad = structuredClone(page.bundle);
bad.page.widgets.push({ id: "w_bad", type: "echarts.bar", grid: { x: 0, y: 40, w: 4, h: 4 }, dataset: "nope", props: {} });
const v = await (await api("/api/projects/demo/validate", { method: "POST", json: { bundle: bad } })).json();
check("validate reports errors", v.ok === false && v.errors.length >= 2, v.errors.map((e: { message: string }) => e.message).join(" | "));

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
