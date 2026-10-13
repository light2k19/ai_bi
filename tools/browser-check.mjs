/**
 * Browser smoke test with the locally installed Edge/Chrome (playwright-core, no browser download).
 * Usage: node tools/browser-check.mjs <outDir> [path ...]
 * Signs in as the demo admin, visits each path, waits for the page runtime, saves screenshots and
 * prints console errors from the host and the runtime iframe.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "screens";
const paths = process.argv.slice(3);
const base = process.env.WEB ?? "http://localhost:5173";
const user = process.env.USER_EMAIL ?? "admin@example.com";
const pass = process.env.USER_PASSWORD ?? "admin1234";
fs.mkdirSync(out, { recursive: true });

const exe = [
  process.env.AIBI_BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && fs.existsSync(p));
if (!exe) throw new Error("no Edge/Chrome found");

const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await browser.newContext({ viewport: { width: Number(process.env.W ?? 1440), height: Number(process.env.H ?? 1000) }, colorScheme: process.env.DARK ? "dark" : "light" });
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`);
});
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(`${base}/login`);
await page.fill('input[type="email"]', user);
await page.fill('input[type="password"]', pass);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });

let i = 0;
for (const p of paths.length ? paths : ["/", "/p/demo", "/p/demo/pages/pg_demo_sales"]) {
  i++;
  logs.length = 0;
  const t0 = Date.now();
  await page.goto(base + p, { waitUntil: "load" });
  // wait for runtime frames (if any) to report widgets, then for loading spinners to go
  const frameEl = await page.waitForSelector("iframe", { timeout: 8000 }).catch(() => null);
  if (frameEl) {
    const f = await frameEl.contentFrame();
    await f?.waitForSelector(".rt-card, .rt-empty", { timeout: 30000 }).catch(() => logs.push("[check] no widgets rendered within 30s"));
    await f?.waitForFunction(() => !document.querySelector(".rt-loading"), null, { timeout: 30000 }).catch(() => logs.push("[check] still loading after 30s"));
    await page.waitForTimeout(Number(process.env.SETTLE ?? 2500));
    const errs = await f?.$$eval(".rt-error, .rt-missing", (els) => els.map((e) => e.closest("[data-widget]")?.getAttribute("data-widget") + ": " + e.textContent?.slice(0, 200)));
    if (errs?.length) logs.push(...errs.map((e) => `[widget] ${e}`));
  } else await page.waitForTimeout(1500);
  const file = path.join(out, `${String(i).padStart(2, "0")}-${p.replace(/[^a-z0-9]+/gi, "_").slice(0, 60) || "root"}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`${p} → ${file} (${Date.now() - t0} ms)`);
  for (const l of logs) console.log("   ", l);
}
await browser.close();
