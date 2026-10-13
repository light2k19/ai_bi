import { chromium, type Browser } from "playwright-core";
import fs from "node:fs";
import { defineServerSkill } from "@aibi/skill-sdk";

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

const CANDIDATES = [
  process.env.AIBI_BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean) as string[];

export function findBrowser(): string | null {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!launching) {
    // an installed Edge/Chrome/Chromium, or else the browser Playwright manages itself
    // (`npx playwright-core install --only-shell chromium`, as the Docker image does)
    const executablePath = findBrowser() ?? undefined;
    launching = chromium.launch({ executablePath, headless: true, args: ["--disable-gpu", "--no-first-run"] }).catch((e: Error) => {
      launching = null;
      throw new Error(executablePath ? `Could not start the browser at ${executablePath}: ${e.message}` : "No Chromium-based browser found on the server. Install Edge or Chrome, set AIBI_BROWSER_PATH, or run `npx playwright-core install --with-deps --only-shell chromium`.");
    }).then((b) => {
      browser = b;
      launching = null;
      b.on("disconnected", () => (browser = null));
      return b;
    });
  }
  return launching;
}

/** Screenshot of a rendered page as a PNG data URL (used by the AI's render_preview tool). */
async function screenshot(input: Record<string, unknown>): Promise<unknown> {
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: Number(input.width ?? 1280), height: Number(input.height ?? 900) }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.goto(String(input.url), { waitUntil: "load", timeout: 60_000 });
    await page.waitForSelector("body[data-ready='1']", { timeout: 90_000 });
    const png = await page.screenshot({ fullPage: true, type: "png" });
    return `data:image/png;base64,${png.toString("base64")}`;
  } finally {
    await context.close();
  }
}

export default defineServerSkill({
  tools: { screenshot: (input) => screenshot(input) },
  export: {
    formats: [{ id: "pdf", label: "PDF document", mime: "application/pdf", ext: "pdf" }],
    async export(_format, ctx) {
      if (!ctx.renderUrl) throw new Error("PDF export needs a render URL");
      const b = await getBrowser();
      const landscape = ctx.options.landscape !== false;
      // viewport = printable width of the paper (A4/Letter minus 8 mm margins) so charts are sized for print
      const context = await b.newContext({ viewport: { width: landscape ? 1060 : 730, height: 900 }, deviceScaleFactor: 2 });
      try {
        const page = await context.newPage();
        await page.emulateMedia({ media: "print" });
        await page.goto(ctx.renderUrl, { waitUntil: "load", timeout: 60_000 });
        // the runtime sets data-ready once all datasets are loaded and entry animations settled
        await page.waitForSelector("body[data-ready='1']", { timeout: 90_000 });
        const pdf = await page.pdf({
          format: (ctx.options.paper as string) === "letter" ? "Letter" : "A4",
          landscape,
          printBackground: true,
          margin: { top: "8mm", bottom: "8mm", left: "8mm", right: "8mm" },
        });
        const safe = ctx.bundle.page.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "page";
        return { body: pdf, mime: "application/pdf", filename: `${safe}.pdf` };
      } finally {
        await context.close();
      }
    },
  },
});
