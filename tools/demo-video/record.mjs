/**
 * Records the product demo against a running dev instance (web on :5173, demo project seeded, AI configured).
 *
 *   node tools/demo-video/record.mjs <framesDir>
 *
 * Frames come from the browser's screencast (sharp text, unlike a low-bitrate video capture) with a timestamp
 * each; markers.json records when the AI was working so build.mjs can fast-forward those stretches.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(here, "frames"));
const WEB = process.env.DEMO_WEB ?? "http://localhost:5173";
const BROWSER = process.env.DEMO_BROWSER ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER = process.env.DEMO_USER ?? "admin@example.com";
const PASS = process.env.DEMO_PASS ?? "admin1234";

const PROMPT_BUILD =
  "Create a 'Regional performance' page for our sales director: KPI cards for revenue, gross margin % and completed orders, each compared with last year; monthly revenue as a line chart with one line per region; target attainment by region as a bar chart, one bar per region, where attainment is the region's revenue divided by the sum of its monthly sales targets for the same months; the top 10 products by revenue as a table; period and region filters; and a short AI commentary on what changed. Show money as currency and attainment as a percentage.";
const PROMPT_REFINE = "Add a donut chart of revenue by sales channel next to the target attainment chart.";
const QUESTION = "Which region is furthest behind its target, and by how much?";

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25, colorScheme: "dark", bypassCSP: true });
await context.addInitScript({ path: path.join(here, "overlay.js") });
const page = await context.newPage();
page.setDefaultTimeout(30_000);

const frames = [];
const markers = {};
const mark = (name) => (markers[name] = Date.now());
const demo = (fn, ...args) => page.evaluate(([f, a]) => window.__demo[f](...a), [fn, args]);

async function center(locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  const b = await locator.boundingBox();
  if (!b) throw new Error(`not visible: ${locator}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}
async function moveTo(locator, ms = 750) {
  const p = await center(locator);
  await Promise.all([demo("cursorTo", p.x, p.y, ms), page.mouse.move(p.x, p.y, { steps: 14 })]);
  return p;
}
async function click(locator, ms) {
  const p = await moveTo(locator, ms);
  await sleep(180);
  await demo("ripple");
  await page.mouse.click(p.x, p.y);
  return p;
}
async function caption(kicker, title, sub, hold = 0) {
  await demo("caption", kicker, title, sub);
  if (hold) await sleep(hold);
}
const fmt = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** wait for an AI turn in the editor chat: the input is disabled while the AI works */
async function waitForBuild(label) {
  const input = page.locator("textarea").first();
  await page.waitForFunction((el) => el.disabled, await input.elementHandle(), { timeout: 15_000 }).catch(() => undefined);
  await page.waitForFunction((el) => !el.disabled, await input.elementHandle(), { timeout: 8 * 60_000, polling: 500 });
  await sleep(1200); // let the preview settle
}

/** The page preview's runtime frame. */
const runtimeFrame = () => page.frames().find((f) => f !== page.mainFrame() && /:\/\/[^/]+:(5174|8798|8788)\//.test(f.url()));

/** A take is only worth keeping when the page shows real numbers: no data errors, no empty KPI values. */
async function pageIssues() {
  const f = runtimeFrame();
  if (!f) return ["no preview"];
  return f.evaluate(() => {
    const out = [];
    const text = document.body.innerText;
    if (/data error|missing value|query failed|no such column|syntax error/i.test(text)) out.push("data error on the page");
    const empty = [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 && e.textContent.trim() === "—" && parseFloat(getComputedStyle(e).fontSize) >= 20).length;
    if (empty) out.push(`${empty} empty KPI value(s)`);
    return out;
  });
}
/** Every dataset of the live page, through the runtime's own getState command (as the Ask AI panel does). */
async function runtimeState() {
  return page.evaluate(
    () =>
      new Promise((res) => {
        const f = document.querySelector("iframe");
        if (!f?.contentWindow) return res(null);
        const on = (e) => {
          if (e.source === f.contentWindow && e.data?.type === "state") {
            window.removeEventListener("message", on);
            res(e.data);
          }
        };
        window.addEventListener("message", on);
        f.contentWindow.postMessage({ type: "command", name: "getState", protocol: "aibi-runtime/1" }, new URL(f.src).origin);
        setTimeout(() => res(null), 6000);
      }),
  );
}

/** The numbers must make sense, not just exist: no failed or empty datasets, attainment between 30 % and 300 %. */
async function dataIssues() {
  const st = await runtimeState();
  if (!st) return ["could not read the page's data"];
  const out = [];
  const plausible = (k) => (k >= 0.3 && k <= 3) || (k >= 30 && k <= 300);
  for (const d of st.datasets) {
    if (d.error) out.push(`${d.id}: ${d.error}`);
    if (!d.rows.length) out.push(`${d.id}: no rows`);
    for (const c of d.columns) {
      const nums = d.rows.map((r) => r[c.name]).filter((v) => typeof v === "number");
      if (!nums.length) continue;
      if (/^(ly|prev|previous|last_?year|py)_|_(ly|prev|previous|last_?year|py)$/i.test(c.name) && nums.every((v) => v === 0)) out.push(`${d.id}.${c.name} is all zero`);
      if (/attain/i.test(c.name)) {
        const bad = nums.filter((v) => !plausible(v));
        if (bad.length) out.push(`${d.id}.${c.name} implausible (${bad.slice(0, 3).map((v) => v.toPrecision(3)).join(", ")})`);
      }
      if (/target/i.test(c.name)) {
        const rev = d.columns.find((x) => /revenue|actual|sales/i.test(x.name) && !/target|attain/i.test(x.name));
        const row = rev && d.rows.find((r) => typeof r[c.name] === "number" && r[c.name] > 0 && typeof r[rev.name] === "number");
        if (row && !plausible(row[rev.name] / row[c.name])) out.push(`${d.id}: ${rev.name} / ${c.name} = ${(row[rev.name] / row[c.name]).toPrecision(3)}`);
      }
    }
  }
  return out;
}

/** The AI commentary must have something to say: wait for it, then reject "insufficient data" style answers. */
async function commentaryIssues() {
  const f = runtimeFrame();
  if (!f) return [];
  if (!(await f.locator(".aibi-narrative").count())) return [];
  const md = f.locator(".aibi-narr-md, .aibi-narr-error").first();
  await md.waitFor({ timeout: 45_000 }).catch(() => undefined);
  const text = (await md.textContent().catch(() => "")) ?? "";
  if (!text.trim()) return ["commentary did not appear"];
  return /insufficient|unable to|cannot|can't|not available|no data|missing|error|couldn/i.test(text) ? [`commentary: "${text.slice(0, 90)}…"`] : [];
}

/** The page design as the editor holds it (its draft in IndexedDB). */
async function draftBundle() {
  for (let i = 0; i < 10; i++) {
    const b = await page.evaluate(
      () =>
        new Promise((res) => {
          const r = indexedDB.open("aibi-local");
          r.onerror = () => res(null);
          r.onsuccess = () => {
            try {
              const q = r.result.transaction("drafts").objectStore("drafts").getAll();
              q.onsuccess = () => res(q.result.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.bundle ?? null);
              q.onerror = () => res(null);
            } catch {
              res(null);
            }
          };
        }),
    );
    if (b?.page?.widgets?.length) return b;
    await sleep(500);
  }
  return null;
}

/** Charts must say what the prompt asked: a line per region, money as currency, attainment as a percentage. */
async function designIssues() {
  const [bundle, st] = [await draftBundle(), await runtimeState()];
  if (!bundle || !st) return ["could not read the page design"];
  const out = [];
  const data = new Map(st.datasets.map((d) => [d.id, d]));
  const fmt = (f, col) => JSON.stringify(typeof f === "object" && f ? f[col] ?? f : f ?? "");
  for (const w of bundle.page.widgets) {
    const p = w.props ?? {};
    const d = data.get(w.dataset);
    if (/echarts\.(line|area)/.test(w.type) && d) {
      const regionCol = d.columns.find((c) => /region/i.test(c.name))?.name;
      const distinct = regionCol ? new Set(d.rows.map((r) => r[regionCol])).size : 0;
      const series = Array.isArray(p.series) ? p.series.length : p.series ? 1 : 0;
      if (distinct > 1 && !p.groupBy && series < 2) out.push(`${w.id}: line chart not split by region`);
    }
    if (/echarts\.bar/.test(w.type) && d) {
      const att = d.columns.find((c) => /attain/i.test(c.name))?.name;
      if (att && !/percent/i.test(fmt(p.format, att))) out.push(`${w.id}: attainment not formatted as a percentage`);
    }
    const kpis = w.type === "kpiRow" ? (p.items ?? []).map((it) => ({ ...it, dataset: it.dataset ?? w.dataset })) : w.type === "kpi" ? [p] : [];
    for (const k of kpis) if (/revenue/i.test(`${k.label ?? ""} ${k.title ?? ""} ${typeof k.value === "string" ? k.value : ""}`) && !/currency/i.test(JSON.stringify(k.format ?? ""))) out.push(`${w.id}: revenue KPI not formatted as currency`);
  }
  return out;
}

/** Everything the prompt asked for must be there after the first build, not only some of it. */
async function completenessIssues() {
  const b = await draftBundle();
  if (!b) return ["could not read the page design"];
  const types = b.page.widgets.map((w) => w.type);
  const need = [
    ["KPI cards", (t) => /^kpi/.test(t)],
    ["line chart", (t) => /echarts\.(line|area)/.test(t)],
    ["bar chart", (t) => /echarts\.bar/.test(t)],
    ["table", (t) => /table/.test(t)],
    ["AI commentary", (t) => t === "narrative"],
  ];
  const out = need.filter(([, f]) => !types.some(f)).map(([n]) => `missing ${n}`);
  if ((b.page.filters ?? []).length < 2) out.push("missing period or region filter");
  return out;
}

/** Pick one value in a filter of the live page, native select or the multi-select popover; returns its label. */
async function pickFilter(rt, labelRe, valueRe) {
  const field = rt.locator(".aibi-filter").filter({ hasText: labelRe }).first();
  if (!(await field.count())) return null;
  const native = field.locator("select");
  if (await native.count()) {
    await click(native.first(), 900);
    const labels = await native.first().locator("option").allTextContents();
    const i = labels.findIndex((l) => valueRe.test(l));
    if (i < 0) return null;
    await native.first().selectOption({ index: i });
    return labels[i].trim();
  }
  const btn = field.locator(".aibi-multi-btn");
  if (!(await btn.count())) return null;
  await click(btn.first(), 900);
  const option = rt.locator(".aibi-popover .aibi-check").filter({ hasText: valueRe }).first();
  await option.waitFor({ timeout: 5000 });
  await sleep(500);
  const label = (await option.locator(".aibi-check-label").textContent())?.trim() ?? "";
  await click(option.locator("input"), 700);
  await sleep(400);
  await click(btn.first(), 600); // close the popover
  return label;
}
async function resetFilter(rt, labelRe) {
  const field = rt.locator(".aibi-filter").filter({ hasText: labelRe }).first();
  const native = field.locator("select");
  if (await native.count()) return native.first().selectOption({ index: 0 });
  const btn = field.locator(".aibi-multi-btn").first();
  await btn.click();
  await rt.locator(".aibi-popover .aibi-check-all input").first().click();
  await btn.click();
}

const charts = async () => (await runtimeFrame()?.evaluate(() => document.querySelectorAll("[data-widget]").length)) ?? 0;

/* ───────── sign in (not recorded) ───────── */
await page.goto(`${WEB}/login`);
await page.fill('input[autocomplete="username"]', USER);
await page.fill('input[type="password"]', PASS);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.startsWith("/login"));
if (process.env.DEMO_CLEAN === "1") {
  // only for a throw-away demo instance: remove pages earlier takes saved
  const removed = await page.evaluate(async () => {
    const pages = await (await fetch("/api/projects/demo/pages")).json();
    const old = pages.filter((p) => /regional performance/i.test(p.title));
    for (const p of old) await fetch(`/api/projects/demo/pages/${p.id}`, { method: "DELETE", headers: { "x-requested-with": "demo" } });
    return old.length;
  });
  console.log(`removed ${removed} page(s) from earlier takes`);
}
await page.goto(`${WEB}/`);
await page.getByText("Demo Co. analytics").first().waitFor();
await sleep(800);

/* ───────── screencast ───────── */
const cdp = await context.newCDPSession(page);
let n = 0;
cdp.on("Page.screencastFrame", async (e) => {
  const file = `f${String(n++).padStart(6, "0")}.jpg`;
  frames.push({ file, t: Date.now() });
  fs.writeFile(path.join(OUT, file), Buffer.from(e.data, "base64"), () => undefined);
  await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => undefined);
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
mark("start");

let failure = null;
try {
  /* intro card */
  await demo("cursor", false);
  await demo(
    "card",
    `<div class="logo"><i>📊</i> AI BI</div><h1>From a question to a <em>live dashboard</em><br/>in minutes</h1><p>Describe what you need. The AI builds it on your real data — read-only, governed and ready to share.</p><p style="font-size:15px;margin-top:46px;color:#7f8bab;letter-spacing:.04em">RECORDED LIVE · AI WAITING TIME FAST-FORWARDED</p>`,
  );
  await sleep(5200);
  await demo("card", null);
  await sleep(900);
  await demo("cursor", true);

  /* projects */
  await caption("Your workspace", "Every team gets its own project", "Each with its own data sources, skills, members and roles.");
  await moveTo(page.getByText("Demo Co. analytics").first(), 1100);
  await sleep(2200);
  await click(page.getByText("Demo Co. analytics").first(), 500);
  await page.waitForURL(/\/p\/demo$/);
  await page.getByRole("button", { name: "New page with AI" }).first().waitFor();
  await sleep(600);

  /* project home */
  await caption("Demo Co. analytics", "Live pages on the company's sales database", "Let's build a new one for the sales director — no code, no SQL.");
  await sleep(2600);
  await click(page.getByRole("button", { name: "New page with AI" }).first(), 900);
  await page.locator("textarea").first().waitFor();
  await sleep(1200);

  /* step 1: describe */
  await caption("Step 1 · Describe", "Say what you need, in plain language", `“${PROMPT_BUILD}”`);
  const chat = page.locator("textarea").first();
  await click(chat, 900);
  await sleep(300);
  mark("type1-start");
  await page.keyboard.type(PROMPT_BUILD, { delay: 16 });
  mark("type1-end");
  await sleep(900);

  /* step 2: the AI builds */
  await page.keyboard.press("Enter");
  mark("build1-start");
  await caption("Step 2 · AI builds", "It reads the schema, writes read-only SQL and designs the page", "Every query is checked and runs read-only, with row and time limits.");
  await demo("timerStart", "AI is building your page", "⏩ FAST-FORWARD");
  const preview = page.locator("iframe").first();
  await moveTo(preview, 1200).catch(() => undefined);
  await waitForBuild();
  mark("build1-end");
  const issues1 = [...(await completenessIssues()), ...(await pageIssues()), ...(await dataIssues()), ...(await designIssues())];
  if (!issues1.length) issues1.push(...(await commentaryIssues()));
  if (issues1.length) throw Object.assign(new Error(`bad take after the build: ${issues1.join(", ")}`), { badTake: true });
  const chartsBefore = await charts();
  const widgetsBefore = (await runtimeFrame()?.evaluate(() => [...document.querySelectorAll("[data-widget]")].map((e) => e.getAttribute("data-widget")))) ?? [];
  const build1 = markers["build1-end"] - markers["build1-start"];
  await demo("timerDone", `Page built in ${fmt(build1)}`);
  const cost = (await page.getByText(/^\$\d+\.\d{2,4}$/).last().textContent().catch(() => ""))?.trim();
  const costNote = cost ? ` for ${Number(cost.slice(1)) < 0.1 ? `${Math.max(1, Math.round(Number(cost.slice(1)) * 100))}¢` : `$${Number(cost.slice(1)).toFixed(2)}`}` : "";
  await caption("Ready", `A live page on real data — built in ${fmt(build1)}${costNote}`, "KPIs, charts, filters and an AI commentary that follows the data.");
  await sleep(2400);
  const pr = await center(preview);
  await demo("spot", { x: pr.box.x, y: pr.box.y, width: pr.box.width, height: Math.min(pr.box.height, 864 - pr.box.y - 10) }, 0);
  await sleep(2200);
  await demo("spot", null);
  await demo("timerHide");

  /* explore the preview: switch the canvas from layout editing to the live page */
  await click(page.getByRole("button", { name: "Preview" }).first(), 900);
  await sleep(1200);
  await caption("Explore", "Everything is interactive", "Scroll, filter, hover — the preview is the real page.");
  await demo("scrollBy", 520, 2600);
  await sleep(1400);
  const rt = page.frameLocator("iframe").first();
  const chart = rt.locator("canvas").first();
  if (await chart.count()) {
    const c = await moveTo(chart, 900).catch(() => null);
    if (c) {
      for (const fx of [0.25, 0.45, 0.65, 0.85]) {
        const x = c.box.x + c.box.width * fx;
        await Promise.all([demo("cursorTo", x, c.y, 500), page.mouse.move(x, c.y, { steps: 10 })]);
        await sleep(650);
      }
    }
  }
  await demo("scrollBy", 520, 2200);
  await sleep(1600);
  await demo("scrollBy", -2000, 1800);
  await sleep(600);
  // filter by one region: every KPI, chart and the commentary follow
  const picked = await pickFilter(rt, /region/i, /^\s*(west|north|south|east|central)/i).catch((e) => (console.log("region filter skipped:", e.message), null));
  console.log(`region filter: ${picked ?? "skipped"}`);
  if (picked) {
    await caption("Explore", `Pick a region — every KPI and chart follows`, `Showing ${picked}: queries re-run live against the database, through the governed gateway.`);
    await sleep(3800);
    await resetFilter(rt, /region/i).catch(() => undefined);
    await sleep(1800);
  }

  await click(page.getByRole("button", { name: "Edit layout" }).first(), 800).catch(() => undefined);
  await sleep(800);

  /* step 3: refine */
  await caption("Step 3 · Refine", "Keep talking to change it", `“${PROMPT_REFINE}”`);
  await click(chat, 1000);
  mark("type2-start");
  await page.keyboard.type(PROMPT_REFINE, { delay: 18 });
  mark("type2-end");
  await sleep(700);
  await page.keyboard.press("Enter");
  mark("build2-start");
  await demo("timerStart", "AI is updating the page", "⏩ FAST-FORWARD");
  await moveTo(preview, 1000).catch(() => undefined);
  await waitForBuild();
  mark("build2-end");
  const issues2 = [...(await pageIssues()), ...(await dataIssues())];
  if (issues2.length || (await charts()) <= chartsBefore) throw Object.assign(new Error(`bad take after the refinement: ${issues2.join(", ") || "no new chart"}`), { badTake: true });
  await demo("timerDone", `Updated in ${fmt(markers["build2-end"] - markers["build2-start"])}`);
  const added = ((await runtimeFrame()?.evaluate(() => [...document.querySelectorAll("[data-widget]")].map((e) => e.getAttribute("data-widget")))) ?? []).filter((id) => !widgetsBefore.includes(id));
  const fresh = added.length ? page.frameLocator("iframe").first().locator(`[data-widget="${added[0]}"]`) : null;
  if (fresh) {
    const b0 = await fresh.boundingBox();
    if (b0 && (b0.y < 160 || b0.y + b0.height > 820)) {
      await demo("scrollBy", b0.y - 260, 1300);
      await sleep(400);
    }
    const b = await fresh.boundingBox();
    if (b) {
      await Promise.all([demo("cursorTo", b.x + b.width / 2, b.y + b.height / 2, 800), page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })]);
      await demo("spot", { x: b.x, y: b.y, width: b.width, height: b.height }, 6);
      await caption("Step 3 · Refine", "There it is — revenue by channel", "Added to the layout, wired to the same filters.");
      await sleep(3000);
      await demo("spot", null);
    }
  } else await sleep(2600);
  await demo("timerHide");

  /* step 4: save and share */
  await caption("Step 4 · Share", "Save it — versioned and permission-aware", "Members see it by role; admins control versions, data sources and AI.");
  await click(page.getByRole("button", { name: "Save page" }), 900);
  const msg = page.getByPlaceholder("e.g. Added margin trend and region filter");
  await msg.waitFor();
  await sleep(400);
  await page.keyboard.type("Regional performance for the sales director", { delay: 22 });
  await sleep(600);
  await click(page.locator("[role=dialog]").last().getByRole("button", { name: "Save", exact: true }), 700);
  await page.waitForURL(/\/pages\/[^/]+\/edit$/, { timeout: 30_000 });
  await sleep(1500);
  await click(page.getByRole("button", { name: "Back" }).first(), 800);
  await page.waitForURL(/\/pages\/[^/]+$/);
  await page.locator("iframe").first().waitFor();
  await sleep(3000);
  await caption("Shared", "Live for the whole team", "Opens instantly, always on the latest data.");
  await sleep(1200);
  await demo("scrollBy", 1400, 4200, "main");
  await sleep(1400);
  await demo("scrollBy", -3000, 1800, "main");
  await sleep(600);

  /* ask the data */
  await caption("Ask the data", "Anyone can ask questions about the page", "Answers come from the numbers on screen — no analyst needed.");
  await click(page.getByRole("button", { name: "Ask AI" }).first(), 900);
  const ask = page.getByPlaceholder("Ask a question…");
  await ask.waitFor();
  await click(ask, 700);
  await page.keyboard.type(QUESTION, { delay: 22 });
  await sleep(500);
  const finished = page.waitForEvent("requestfinished", { predicate: (r) => r.url().includes("/ai/ask"), timeout: 3 * 60_000 });
  await page.keyboard.press("Enter");
  mark("ask-start");
  await finished;
  mark("ask-end");
  await sleep(800);
  const answer = (await page.locator("aside").last().innerText().catch(() => "")) ?? "";
  if (/apolog|sorry|mistake|error in my/i.test(answer)) throw Object.assign(new Error("bad take: the Ask AI answer apologises"), { badTake: true });
  await sleep(3800);

  /* exports */
  await caption("Take it anywhere", "Export to PDF or Excel — or package it for another project");
  await click(page.getByRole("button", { name: "Export" }).first(), 900);
  await sleep(2600);
  await page.keyboard.press("Escape");
  await sleep(600);

  /* outro */
  await demo("caption", null);
  await demo("cursor", false);
  await demo(
    "card",
    `<div class="logo"><i>📊</i> AI BI</div><h1>Ask. Build. <em>Share.</em></h1>
     <ul>
       <li><b>✓</b>Read-only by design — every query checked</li>
       <li><b>✓</b>Runs on your server or in Docker</li>
       <li><b>✓</b>SQL databases, REST and GraphQL APIs</li>
       <li><b>✓</b>Any AI model — cloud or local</li>
       <li><b>✓</b>Roles, Active Directory sign-in, audit log</li>
       <li><b>✓</b>Versions with enable, disable and default</li>
     </ul>
     <div class="cta">Your data, explained — in minutes</div>`,
  );
  await sleep(900);
  await demo("revealCard");
  await sleep(6500);
  mark("end");
} catch (e) {
  failure = e;
  console.error("demo step failed:", e.message);
  await page.screenshot({ path: path.join(OUT, "failure.png") }).catch(() => undefined);
  mark("end");
} finally {
  await cdp.send("Page.stopScreencast").catch(() => undefined);
  await sleep(500);
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({ frames, markers, url: page.url() }, null, 1));
  console.log(`frames: ${frames.length}, markers: ${Object.keys(markers).join(", ")}`);
  for (const [a, b] of [["build1-start", "build1-end"], ["build2-start", "build2-end"], ["ask-start", "ask-end"]])
    if (markers[a] && markers[b]) console.log(`${a.replace("-start", "")}: ${((markers[b] - markers[a]) / 1000).toFixed(1)}s`);
  console.log(`total real time: ${((markers.end - markers.start) / 1000).toFixed(1)}s`);
  await browser.close();
  process.exit(failure ? (failure.badTake ? 3 : 1) : 0);
}
