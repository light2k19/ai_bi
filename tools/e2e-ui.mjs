/**
 * UI end-to-end checks: filters, Ask AI, package export, open-local, import wizard.
 * Usage: node tools/e2e-ui.mjs <outDir>
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "screens-ui";
const base = process.env.WEB ?? "http://localhost:5173";
fs.mkdirSync(out, { recursive: true });
const exe = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true });
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function login(email, password) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("   pageerror:", e.message));
  await page.goto(`${base}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  return page;
}
async function runtimeFrame(page) {
  const f = await (await page.waitForSelector("iframe")).contentFrame();
  await f.waitForSelector(".rt-card", { timeout: 30000 });
  await f.waitForFunction(() => !document.querySelector(".rt-loading"), null, { timeout: 30000 });
  return f;
}
const kpiText = (f) => f.$eval('[data-widget="kpi_revenue"]', (e) => e.textContent ?? "");

/* ── viewer ── */
const viewer = await login("viewer@example.com", "viewer1234");
await viewer.goto(`${base}/p/demo/pages/pg_demo_sales`);
let f = await runtimeFrame(viewer);
await viewer.waitForTimeout(2000);
const before = await kpiText(f);
// change the period filter through the filter UI
const periodSelect = await f.$(".rt-filter select");
await periodSelect.selectOption({ label: await periodSelect.$$eval("option", (os) => os.find((o) => /last quarter/i.test(o.textContent ?? ""))?.textContent ?? "") });
await f.waitForFunction(() => !document.querySelector(".rt-loading"), null, { timeout: 30000 });
await viewer.waitForTimeout(2000);
const after = await kpiText(f);
check("period filter reloads KPIs", before !== after, `${before.slice(0, 40)} → ${after.slice(0, 40)}`);
await viewer.screenshot({ path: path.join(out, "viewer-filtered.png") });

// Ask AI
await viewer.click("button:has-text('Ask AI')");
await viewer.click("button:has-text('Summarise this page')");
await viewer.waitForFunction(() => [...document.querySelectorAll("aside .md")].some((e) => (e.textContent ?? "").length > 60), null, { timeout: 120000 });
const answer = await viewer.$$eval("aside .md", (els) => els.map((e) => e.textContent).join(" "));
check("Ask AI answers from page data", answer.length > 60, answer.slice(0, 160).replace(/\s+/g, " "));
await viewer.screenshot({ path: path.join(out, "viewer-ask.png") });

// export package
await viewer.click("button:has-text('Export')");
const [dl] = await Promise.all([viewer.waitForEvent("download"), viewer.click("button:has-text('Page package')")]);
const pkg = path.join(out, dl.suggestedFilename());
await dl.saveAs(pkg);
check("export .aibi package", fs.statSync(pkg).size > 1000, `${dl.suggestedFilename()} ${fs.statSync(pkg).size} bytes`);
const viewerEdit = await viewer.$("button:has-text('Edit')");
check("viewer sees no Edit button", !viewerEdit);

/* ── builder ── */
const builder = await login("builder@example.com", "builder1234");
await builder.goto(`${base}/p/demo`);
await builder.click("button:has-text('Open local file')");
const input = await builder.$('div[role=dialog] input[type="file"][multiple]');
await input.setInputFiles(pkg);
await builder.waitForURL(/\/local\/loc_/, { timeout: 20000 });
f = await runtimeFrame(builder);
const localWidgets = await f.$$eval("[data-widget]", (els) => els.length);
check("open .aibi as browser-local page", localWidgets >= 9, `${localWidgets} widgets, url ${builder.url()}`);
await builder.screenshot({ path: path.join(out, "builder-local.png") });

// import wizard
await builder.goto(`${base}/p/demo/import`);
await builder.setInputFiles('input[type="file"]', pkg);
await builder.waitForSelector("text=Data sources", { timeout: 20000 });
await builder.screenshot({ path: path.join(out, "builder-import-report.png"), fullPage: true });
const modeSelect = await builder.$("select >> nth=-1");
const modes = await modeSelect.$$eval("option", (os) => os.map((o) => o.value));
await modeSelect.selectOption(modes.includes("copy") ? "copy" : modes[0]);
await builder.fill('input[value^="Sales performance"]', "Sales performance (imported by e2e)");
await builder.click("button:has-text('Import page')");
await builder.waitForURL(/\/pages\/pg_/, { timeout: 30000 });
f = await runtimeFrame(builder);
const title = await builder.$eval("h1", (e) => e.textContent);
check("import wizard creates the page", /imported by e2e/.test(title ?? ""), `${title} at ${builder.url()}`);
await builder.screenshot({ path: path.join(out, "builder-imported.png") });

await browser.close();
console.log(failures ? `\n${failures} failure(s)` : "\nall UI checks passed");
process.exit(failures ? 1 : 0);
