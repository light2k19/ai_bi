/**
 * Demo seed: users, a demo project with a SQLite data source over a generated company database,
 * schema annotations and a sample page. Safe to re-run (skips what exists unless --reset).
 */
import path from "node:path";
import fs from "node:fs";
import { config } from "./config";
import { migrate, get, run, now, json } from "./db";
import { loadSkills } from "./skills/registry";
import { hashPassword, newId } from "./lib/crypto";
import { buildDemoDatabase, DEMO_ANNOTATIONS } from "./demo-data";
import { createInstance, introspectInstance, setAnnotations } from "./services/sources";
import { createPage } from "./services/pages";
import type { User } from "./services/access";

const reset = process.argv.includes("--reset");

function ensureUser(email: string, password: string, name: string, admin = false): string {
  const u = get<{ id: string }>("SELECT id FROM users WHERE email = ?", email);
  if (u) return u.id;
  const id = newId("usr");
  run("INSERT INTO users (id, login, email, display_name, password_hash, auth_provider, is_platform_admin, created_at) VALUES (?,?,?,?,?,?,?,?)", id, email, email, name, hashPassword(password), "local", admin ? 1 : 0, now());
  return id;
}

const REGION_FILTER = "(:allRegions = 1 OR region IN (:regions))";
const P = {
  start: "{{filters.date.start}}",
  end: "{{filters.date.endExclusive}}",
  allRegions: "{{filters.region.allFlag}}",
  regions: "{{filters.region.values}}",
};

export const SAMPLE_PAGE = {
  page: {
    id: "pg_demo_sales",
    title: "Sales performance",
    description: "Revenue, margin and target attainment by month, region, channel and product",
    tags: ["sales", "demo"],
    filters: [
      { id: "date", type: "dateRange", label: "Period", default: { preset: "YTD" }, presets: ["MTD", "QTD", "YTD", "lastQuarter", "lastYear", "last12m", "custom"] },
      { id: "region", type: "multiSelect", label: "Region", options: { dataset: "region_list", value: "region" }, default: "all" },
    ],
    datasets: [
      { id: "region_list", source: "sales", request: { sql: "SELECT name AS region FROM regions ORDER BY name" }, cache: { ttlSeconds: 3600 } },
      {
        id: "kpis",
        source: "sales",
        request: {
          sql: `SELECT
  SUM(CASE WHEN order_date >= :start AND order_date < :end THEN revenue END) AS revenue,
  SUM(CASE WHEN order_date >= :lyStart AND order_date < :lyEnd THEN revenue END) AS ly_revenue,
  SUM(CASE WHEN order_date >= :start AND order_date < :end THEN margin END) * 1.0
    / NULLIF(SUM(CASE WHEN order_date >= :start AND order_date < :end THEN revenue END), 0) AS margin_pct,
  COUNT(DISTINCT CASE WHEN order_date >= :start AND order_date < :end THEN order_id END) AS orders,
  (SELECT SUM(t.target_amount) FROM sales_targets t JOIN regions r ON r.id = t.region_id
    WHERE t.month >= substr(:start, 1, 7) AND t.month <= substr(:endIncl, 1, 7) AND (:allRegions = 1 OR r.name IN (:regions))) AS target
FROM v_sales
WHERE status = 'Completed' AND order_date >= :lyStart AND order_date < :end AND ${REGION_FILTER}`,
          params: { ...P, lyStart: "{{filters.date.lyStart}}", lyEnd: "{{filters.date.lyEndExclusive}}", endIncl: "{{filters.date.end}}" },
        },
      },
      {
        id: "trend",
        source: "sales",
        request: {
          sql: `SELECT month, SUM(revenue) AS revenue, SUM(margin) AS margin
FROM v_sales
WHERE status = 'Completed' AND order_date >= :lyStart AND order_date < :end AND ${REGION_FILTER}
GROUP BY month ORDER BY month`,
          params: { end: P.end, allRegions: P.allRegions, regions: P.regions, lyStart: "{{filters.date.lyStart}}" },
        },
        pipeline: [
          { op: "fillGaps", column: "month", unit: "month", fill: 0 },
          { op: "periodCompare", dateColumn: "month", unit: "month", shift: 12, measures: ["revenue"], prefix: "ly_" },
          { op: "filter", where: "month >= left('{{filters.date.start}}', 7)" },
        ],
      },
      {
        id: "by_region",
        source: "sales",
        request: {
          sql: `SELECT s.region, SUM(s.revenue) AS revenue,
  (SELECT SUM(t.target_amount) FROM sales_targets t JOIN regions r ON r.id = t.region_id
    WHERE r.name = s.region AND t.month >= substr(:start, 1, 7) AND t.month <= substr(:endIncl, 1, 7)) AS target
FROM v_sales s
WHERE s.status = 'Completed' AND s.order_date >= :start AND s.order_date < :end AND (:allRegions = 1 OR s.region IN (:regions))
GROUP BY s.region ORDER BY revenue DESC`,
          params: { ...P, endIncl: "{{filters.date.end}}" },
        },
        pipeline: [{ op: "calc", columns: { attainment: "safeDiv(revenue, target)" } }],
      },
      {
        id: "by_channel",
        source: "sales",
        request: {
          sql: `SELECT channel, SUM(revenue) AS revenue FROM v_sales
WHERE status = 'Completed' AND order_date >= :start AND order_date < :end AND ${REGION_FILTER}
GROUP BY channel ORDER BY revenue DESC`,
          params: P,
        },
      },
      {
        id: "top_products",
        source: "sales",
        request: {
          sql: `SELECT product, category, SUM(quantity) AS units, SUM(revenue) AS revenue, SUM(margin) * 1.0 / NULLIF(SUM(revenue), 0) AS margin_pct
FROM v_sales
WHERE status = 'Completed' AND order_date >= :start AND order_date < :end AND ${REGION_FILTER}
GROUP BY product, category ORDER BY revenue DESC LIMIT 10`,
          params: P,
        },
      },
    ],
    widgets: [
      { id: "kpi_revenue", type: "kpi", grid: { x: 0, y: 0, w: 3, h: 4 }, dataset: "kpis", props: { value: "revenue", label: "Revenue", format: "compactCurrency", compare: "ly_revenue", compareLabel: "vs last year", icon: "💰" } },
      { id: "kpi_target", type: "kpi", grid: { x: 3, y: 0, w: 3, h: 4 }, dataset: "kpis", props: { value: "revenue", label: "Target attainment", format: "compactCurrency", target: "target", icon: "🎯" } },
      { id: "kpi_margin", type: "kpi", grid: { x: 6, y: 0, w: 3, h: 4 }, dataset: "kpis", props: { value: "margin_pct", label: "Gross margin", format: "percent", icon: "📈" } },
      { id: "kpi_orders", type: "kpi", grid: { x: 9, y: 0, w: 3, h: 4 }, dataset: "kpis", props: { value: "orders", label: "Orders", format: "integer", icon: "🧾" } },
      {
        id: "trend_chart",
        type: "echarts.line",
        title: "Monthly revenue vs last year",
        subtitle: "Completed orders",
        grid: { x: 0, y: 4, w: 8, h: 9 },
        dataset: "trend",
        props: { x: "month", series: ["revenue", "ly_revenue"], seriesNames: { revenue: "This year", ly_revenue: "Last year" }, dashed: ["ly_revenue"], area: true, smooth: true, format: "compactCurrency", xFormat: "month" },
      },
      { id: "channel_mix", type: "echarts.pie", title: "Channel mix", grid: { x: 8, y: 4, w: 4, h: 9 }, dataset: "by_channel", props: { name: "channel", value: "revenue", donut: true, labels: "percent", format: "compactCurrency" } },
      {
        id: "region_bar",
        type: "echarts.bar",
        title: "Revenue vs target by region",
        subtitle: "Click a region to filter the page",
        grid: { x: 0, y: 13, w: 6, h: 9 },
        dataset: "by_region",
        props: { x: "region", series: ["revenue", "target"], seriesNames: { revenue: "Revenue", target: "Target" }, horizontal: true, format: "compactCurrency" },
        interactions: [{ on: "click", action: "setFilter", filter: "region", value: "{{ [row.region] }}" }],
      },
      {
        id: "products_table",
        type: "table",
        title: "Top 10 products",
        grid: { x: 6, y: 13, w: 6, h: 9 },
        dataset: "top_products",
        props: {
          columns: [
            { key: "product", label: "Product" },
            { key: "category", label: "Category" },
            { key: "units", label: "Units", format: "integer", align: "right" },
            { key: "revenue", label: "Revenue", format: "currency", bar: true, total: "sum" },
            { key: "margin_pct", label: "Margin", format: "percent", heat: true },
          ],
          totals: true,
          density: "compact",
        },
        conditional: [{ when: "row.margin_pct < 0.35", column: "margin_pct", style: { color: "var(--danger)", fontWeight: 600 } }],
      },
      {
        id: "commentary",
        type: "narrative",
        title: "What the numbers say",
        grid: { x: 0, y: 22, w: 12, h: 5 },
        props: { prompt: "Write 3 short bullet points for a sales manager: overall revenue vs last year and target, the best and weakest region by target attainment, and one product or channel insight. Quote numbers.", datasets: ["kpis", "by_region", "by_channel", "top_products"], maxWords: 120 },
      },
    ],
    scripts: [{ name: "intro", runOn: "page:dataLoaded", description: "Staged reveal of the page and a pulse on the weakest region" }],
  },
  scripts: {
    intro: `import { reveal, stagger, highlight } from "@aibi/anim";

let played = false;
export default async function ({ widgets, data }) {
  if (played) return;
  played = true;
  const order = ["kpi_revenue", "kpi_target", "kpi_margin", "kpi_orders", "trend_chart", "channel_mix", "region_bar", "products_table", "commentary"];
  await reveal(order.map((id) => widgets.get(id)?.el).filter(Boolean), { delay: stagger(90), distance: 18 });
  const regions = data.get("by_region")?.rows ?? [];
  const weakest = [...regions].sort((a, b) => (a.attainment ?? 1) - (b.attainment ?? 1))[0];
  if (weakest && weakest.attainment < 1) {
    widgets.get("region_bar")?.handle.highlight?.([weakest.region]);
    await highlight(widgets.get("region_bar")?.el, { color: "var(--warning)" });
  }
}
`,
  },
  components: {},
  assets: {},
};

async function main() {
  migrate();
  await loadSkills();
  const dbFile = path.join(config.dataDir, "sqlite", "demo.db");
  if (reset || !fs.existsSync(dbFile)) {
    console.log("[seed] generating demo database …");
    const counts = buildDemoDatabase(dbFile);
    console.log(`[seed] demo.db: ${counts.orders} orders, ${counts.lines} order lines, ${counts.gl} ledger entries`);
  }
  const adminId = ensureUser("admin@example.com", "admin1234", "Demo Admin", true);
  const builderId = ensureUser("builder@example.com", "builder1234", "Demo Builder");
  const viewerId = ensureUser("viewer@example.com", "viewer1234", "Demo Viewer");

  let project = get<{ id: string }>("SELECT id FROM projects WHERE slug = 'demo'");
  if (!project) {
    const id = newId("prj");
    run("INSERT INTO projects (id, slug, name, description, settings, created_by, created_at) VALUES (?,?,?,?,?,?,?)", id, "demo", "Demo Co. analytics", "Sales and finance analysis on a generated company database", json({}), adminId, now());
    project = { id };
  }
  for (const [uid, role] of [[adminId, "admin"], [builderId, "builder"], [viewerId, "viewer"]] as const) {
    if (!get("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?", project.id, uid)) run("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?,?,?,?)", project.id, uid, role, now());
  }
  let inst = get<{ id: string }>("SELECT id FROM skill_instances WHERE project_id = ? AND alias = 'sales'", project.id);
  if (!inst) {
    const r = createInstance(project.id, { skill: "datasource-sqlite", name: "Demo Co. warehouse", alias: "sales", description: "Sales orders, products, customers, targets and the finance ledger (budget, P&L, headcount)", config: { file: "demo.db" } });
    inst = { id: r.id };
  }
  run("UPDATE skill_instances SET status = 'ok', status_message = 'demo' WHERE id = ?", inst.id);
  await introspectInstance(project.id, inst.id);
  setAnnotations(inst.id, DEMO_ANNOTATIONS);

  if (!get("SELECT 1 FROM pages WHERE id = ?", SAMPLE_PAGE.page.id)) {
    const admin: User = { id: adminId, login: "admin@example.com", email: "admin@example.com", displayName: "Demo Admin", isPlatformAdmin: true, authProvider: "local" };
    const r = await createPage(project.id, admin, SAMPLE_PAGE as never, { source: "template", message: "Demo page", keepId: true });
    console.log(`[seed] sample page ${r.id} created`);
  }
  console.log("[seed] done. Sign in with admin@example.com / admin1234 (also builder@example.com / builder1234, viewer@example.com / viewer1234)");
}

await main();
