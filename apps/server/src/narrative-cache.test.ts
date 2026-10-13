import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aibi-narr-"));
process.env.AIBI_DATA_DIR = tmp;
process.env.AIBI_SECRET = "test-secret";
const ORIGIN = "http://localhost:5173";

/** A fake OpenAI-compatible provider that counts completions and numbers its answers. */
let calls = 0;
const provider = http.createServer((req, res) => {
  if (req.url?.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
  calls++;
  req.resume();
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `Commentary #${calls}` } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
});

let app: Awaited<ReturnType<typeof import("./app").buildApp>>;
let db: typeof import("./db");
let cookie = "";
let pageId = "";

const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie, origin: ORIGIN, ...(payload !== undefined ? { "content-type": "application/json" } : {}) } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const dataset = (revenue: number) => [{ id: "kpis", columns: [{ name: "revenue", type: "number" }], rows: [{ revenue }] }];
const narrative = (revenue: number, opts: { refresh?: boolean; filters?: Record<string, unknown> } = {}) =>
  call("POST", "/api/projects/acme/ai/narrative", { pageId, widgetId: "w_narr", prompt: "Summarise", datasets: dataset(revenue), page: { title: "P", filters: opts.filters ?? {} }, refresh: opts.refresh });
const pageBundle = (title: string) => ({
  page: { id: "pg_narr", title, widgets: [{ id: "w_narr", type: "narrative", title: "What the numbers say", grid: { x: 0, y: 0, w: 12, h: 4 }, props: { prompt: "Summarise" } }], datasets: [], filters: [], modules: [] },
  components: {},
  scripts: {},
  assets: {},
});

beforeAll(async () => {
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  db = await import("./db");
  db.migrate();
  const { loadSkills } = await import("./skills/registry");
  await loadSkills();
  const { hashPassword, newId } = await import("./lib/crypto");
  db.run("INSERT INTO users (id, login, email, display_name, password_hash, auth_provider, is_platform_admin, created_at) VALUES (?,?,?,?,?,?,?,?)", newId("usr"), "root", "root@example.com", "Root", hashPassword("password123"), "local", 1, db.now());
  const { buildApp } = await import("./app");
  app = await buildApp();
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "root", password: "password123" }, headers: { origin: ORIGIN } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
  expect((await call("POST", "/api/projects", { slug: "acme", name: "Acme" })).status).toBe(200);
  // point the project at the fake provider
  const base = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  db.run("UPDATE projects SET settings = ? WHERE slug = 'acme'", JSON.stringify({ ai: { baseUrl: base } }));
  const created = await call("POST", "/api/projects/acme/pages", { bundle: pageBundle("Board") });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  pageId = created.body.id;
}, 60_000);

afterAll(() => {
  provider.close();
  db?.closeDb?.();
});

describe("AI commentary cache", () => {
  it("reuses the stored commentary until the data changes, someone regenerates, or the page is edited", async () => {
    const first = await narrative(100);
    expect(first.body).toEqual({ text: "Commentary #1", cached: false });
    // same data and filters: no model call, however much later
    db.run("UPDATE narrative_cache SET created_at = '2020-01-01T00:00:00.000Z'");
    expect((await narrative(100)).body).toEqual({ text: "Commentary #1", cached: true });
    expect(calls).toBe(1);
    // other data or other filters: a new commentary
    expect((await narrative(200)).body).toEqual({ text: "Commentary #2", cached: false });
    expect((await narrative(100, { filters: { region: "EU" } })).body.cached).toBe(false);
    expect(calls).toBe(3);
    // regenerate replaces the stored text, which later views then reuse
    expect((await narrative(100, { refresh: true })).body).toEqual({ text: "Commentary #4", cached: false });
    expect((await narrative(100)).body).toEqual({ text: "Commentary #4", cached: true });
    expect(calls).toBe(4);
    // a page edit (new version) clears it
    expect((await call("POST", `/api/projects/acme/pages/${pageId}/versions`, { bundle: pageBundle("Board v2") })).status).toBe(200);
    expect((await narrative(100)).body).toEqual({ text: "Commentary #5", cached: false });
    expect((await narrative(100)).body.cached).toBe(true);
    // so does switching the default version
    expect((await call("PUT", `/api/projects/acme/pages/${pageId}/versions/1/default`, {})).status).toBe(200);
    expect((await narrative(100)).body).toEqual({ text: "Commentary #6", cached: false });
    expect(calls).toBe(6);
  });

  it("drops commentary nobody opened for 60 days", async () => {
    const { sweepCommentary } = await import("./ai/ask");
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM narrative_cache")!.n;
    db.run("UPDATE narrative_cache SET last_used_at = '2020-01-01T00:00:00.000Z' WHERE rowid IN (SELECT rowid FROM narrative_cache LIMIT 1)");
    expect(sweepCommentary()).toBe(1);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM narrative_cache")!.n).toBe(before - 1);
  });
});
