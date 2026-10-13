/**
 * UI end-to-end test of the AI builder: new page → prompt → wait → screenshot → save.
 * Usage: node tools/e2e-ai.mjs <outDir> "<prompt>"
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "screens-ai";
const prompt = process.argv[3] ?? "Create a P&L page: revenue, COGS, gross margin and opex by month, and budget vs actual by department with variance.";
const base = process.env.WEB ?? "http://localhost:5173";
fs.mkdirSync(out, { recursive: true });
const exe = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));

await page.goto(`${base}/login`);
await page.fill('input[type="email"]', "builder@example.com");
await page.fill('input[type="password"]', "builder1234");
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"));
await page.goto(`${base}/p/demo/new`);
await page.waitForSelector("textarea");
const t0 = Date.now();
await page.fill("textarea", prompt);
await page.keyboard.press("Enter");
// wait for the turn to finish: a result badge appears ("page valid" / "N errors" / "no page changes") or an error box
await page.waitForSelector("text=/page valid|errors$|no page changes|AI error|HTTP/", { timeout: 600_000 });
console.log(`AI turn finished in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const badge = await page.locator("text=/page valid|\\d+ errors|no page changes/").first().textContent().catch(() => "?");
console.log("result badge:", badge);
const assistant = await page.locator(".md").last().textContent().catch(() => "");
console.log("assistant:", (assistant ?? "").slice(0, 600));
// let the preview load data
const frame = await (await page.waitForSelector("iframe")).contentFrame();
await frame.waitForSelector(".rt-card", { timeout: 30_000 }).catch(() => console.log("no widgets in preview"));
await frame.waitForFunction(() => !document.querySelector(".rt-loading"), null, { timeout: 60_000 }).catch(() => console.log("preview still loading"));
await page.waitForTimeout(3000);
const widgetErrors = await frame.$$eval(".rt-error, .rt-missing", (els) => els.map((e) => e.closest("[data-widget]")?.getAttribute("data-widget") + ": " + e.textContent?.slice(0, 160)));
console.log("widget errors:", widgetErrors.length ? widgetErrors : "none");
console.log("widgets:", await frame.$$eval("[data-widget]", (els) => els.length));
await page.screenshot({ path: path.join(out, "ai-built.png"), fullPage: false });
const full = await frame.evaluate(() => document.documentElement.scrollHeight);
await page.setViewportSize({ width: 1600, height: Math.min(4000, full + 200) });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, "ai-built-full.png") });

// save
if (/page valid/.test(badge ?? "")) {
  await page.click("button:has-text('Save page')");
  await page.fill('input[placeholder^="e.g. Added"]', "Built by the AI e2e test");
  await page.click("div[role=dialog] button:has-text('Save')");
  await page.waitForURL(/\/pages\/pg_[^/]+\/edit/, { timeout: 30_000 });
  console.log("saved:", page.url());
}
console.log("page errors:", errors.filter((e) => !/Future Flag/.test(e)).slice(0, 10));
await browser.close();
