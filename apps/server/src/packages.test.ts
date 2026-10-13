import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import type { FastifyInstance } from "fastify";

// isolate the data directory before the config module loads
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aibi-packages-"));
process.env.AIBI_DATA_DIR = tmp;
process.env.AIBI_SECRET = "test-secret";
process.env.AIBI_LOGINS_PER_MINUTE = "1000"; // the suite signs in far more often than a browser would

let app: FastifyInstance;
let db: typeof import("./db");
const cookies: Record<string, string> = {};
const ORIGIN = "http://localhost:5173";

async function call(who: string, method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie: cookies[who] ?? "", origin: ORIGIN, ...(payload !== undefined ? { "content-type": "application/json" } : {}) } });
  const isJson = String(r.headers["content-type"] ?? "").includes("json");
  return { status: r.statusCode, body: isJson && r.body ? JSON.parse(r.body) : null, raw: r.rawPayload };
}
async function upload(who: string, url: string, file: Buffer, filename: string) {
  const boundary = "----aibitest" + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const r = await app.inject({ method: "POST", url, payload: Buffer.concat([head, file, tail]), headers: { cookie: cookies[who] ?? "", origin: ORIGIN, "content-type": `multipart/form-data; boundary=${boundary}` } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}

const page = (id: string, title: string, alias = "api") => ({
  page: {
    id,
    title,
    datasets: [{ id: "rows", source: alias, request: { method: "GET", path: "/items", resultPath: "$.data" } }],
    widgets: [{ id: "t", type: "table", grid: { x: 0, y: 0, w: 12, h: 6 }, dataset: "rows", props: {} }],
  },
});

beforeAll(async () => {
  db = await import("./db");
  db.migrate();
  const { loadSkills } = await import("./skills/registry");
  await loadSkills();
  const { hashPassword, newId } = await import("./lib/crypto");
  for (const [email, admin] of [["root@example.com", 1], ["builder@example.com", 0]] as const) {
    db.run("INSERT INTO users (id, login, email, display_name, password_hash, auth_provider, is_platform_admin, created_at) VALUES (?,?,?,?,?,?,?,?)", newId("usr"), email, email, email, hashPassword("password123"), "local", admin, db.now());
  }
  const { buildApp } = await import("./app");
  app = await buildApp();
  for (const who of ["root", "builder"]) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@example.com`, password: "password123" }, headers: { origin: ORIGIN } });
    cookies[who] = String(r.headers["set-cookie"]).split(";")[0];
  }
  // two projects, each with an HTTP data source "api" that has a secret token
  for (const slug of ["finance", "sales"]) {
    expect((await call("root", "POST", "/api/projects", { name: slug[0].toUpperCase() + slug.slice(1), slug, description: `${slug} reports` })).status).toBe(200);
    expect((await call("root", "PUT", `/api/projects/${slug}/skills/datasource-http`, { enabled: true })).status).toBe(200);
    const s = await call("root", "POST", `/api/projects/${slug}/sources`, { skill: "datasource-http", name: "Ledger API", alias: "api", config: { baseUrl: "https://ledger.example.com/v1", authType: "bearer", token: `${slug}-secret-token` } });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    await call("root", "POST", `/api/projects/${slug}/members`, { email: "builder@example.com", role: "builder" });
  }
});
afterAll(async () => {
  await app?.close();
});

let financePageId = "";
let pagePkg: Buffer;

describe("page packages belong to one project", () => {
  it("exports a page package stamped with its project", async () => {
    const created = await call("root", "POST", "/api/projects/finance/pages", { bundle: page("pg_fin_board", "Board pack") });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    financePageId = created.body.id;
    const exp = await call("root", "GET", `/api/projects/finance/pages/${financePageId}/export`);
    expect(exp.status).toBe(200);
    pagePkg = Buffer.from(exp.raw);
    const m = JSON.parse(strFromU8(unzipSync(new Uint8Array(pagePkg))["manifest.json"]));
    expect(m.kind).toBe("page");
    expect(m.project).toMatchObject({ slug: "finance", name: "Finance" });
  });

  it("refuses to import the page into another project", async () => {
    const rep = await upload("root", "/api/projects/sales/import/analyze", pagePkg, "board.aibi");
    expect(rep.status).toBe(200);
    expect(rep.body.origin.slug).toBe("finance");
    expect(rep.body.errors.map((e: { message: string }) => e.message).join(" ")).toMatch(/exported from project “Finance” \(finance\).*only be imported into the project it came from/);
    const commit = await call("root", "POST", `/api/projects/sales/import/${rep.body.importId}/commit`, { mode: "new", mapping: {} });
    expect(commit.status).toBe(422);
  });

  it("asks for confirmation before overwriting an existing page", async () => {
    const rep = await upload("builder", "/api/projects/finance/import/analyze", pagePkg, "board.aibi");
    expect(rep.body.errors).toEqual([]);
    expect(rep.body.conflict).toMatchObject({ existingPageId: financePageId, title: "Board pack", currentVersion: 1 });
    expect(rep.body.modes).toEqual(["version", "copy"]);
    const noConfirm = await call("builder", "POST", `/api/projects/finance/import/${rep.body.importId}/commit`, { mode: "version", mapping: {} });
    expect(noConfirm.status).toBe(409);
    expect(noConfirm.body.details.code).toBe("confirm_overwrite");
    const ok = await call("builder", "POST", `/api/projects/finance/import/${rep.body.importId}/commit`, { mode: "version", mapping: {}, overwrite: true });
    expect(ok.body).toMatchObject({ id: financePageId, versionNo: 2 });
  });

  it("imports a copy without confirmation", async () => {
    const rep = await upload("builder", "/api/projects/finance/import/analyze", pagePkg, "board.aibi");
    const copy = await call("builder", "POST", `/api/projects/finance/import/${rep.body.importId}/commit`, { mode: "copy", mapping: {}, title: "Board pack (copy)" });
    expect(copy.status).toBe(200);
    expect(copy.body.id).not.toBe(financePageId);
  });

  it("accepts page JSON from local tools (no project stamp)", async () => {
    const rep = await upload("builder", "/api/projects/sales/import/analyze", Buffer.from(JSON.stringify(page("pg_local_x", "Local draft"))), "local.json");
    expect(rep.body.errors).toEqual([]);
    expect(rep.body.origin).toBeNull();
  });
});

describe("members", () => {
  it("a disabled member keeps the role but cannot see the project until enabled again", async () => {
    const builder = (await call("root", "GET", "/api/projects/finance/members")).body.find((m: { email: string }) => m.email === "builder@example.com");
    expect(builder.enabled).toBe(true);
    expect((await call("root", "PATCH", `/api/projects/finance/members/${builder.userId}`, { enabled: false })).status).toBe(200);
    expect((await call("builder", "GET", "/api/projects/finance")).status).toBe(404);
    expect((await call("builder", "GET", "/api/projects/finance/pages")).status).toBe(404);
    expect((await call("builder", "GET", "/api/projects")).body.some((p: { slug: string }) => p.slug === "finance")).toBe(false);
    const listed = (await call("root", "GET", "/api/projects/finance/members")).body.find((m: { userId: string }) => m.userId === builder.userId);
    expect(listed).toMatchObject({ role: "builder", enabled: false });
    // the only enabled admin cannot be disabled or demoted, and nobody disables themselves
    const root = (await call("root", "GET", "/api/projects/finance/members")).body.find((m: { role: string; enabled: boolean }) => m.role === "admin" && m.enabled);
    expect((await call("root", "PATCH", `/api/projects/finance/members/${root.userId}`, { enabled: false })).status).toBe(400);
    expect((await call("root", "PATCH", `/api/projects/finance/members/${root.userId}`, { role: "viewer" })).status).toBe(400);
    expect((await call("root", "PATCH", `/api/projects/finance/members/${builder.userId}`, { enabled: true })).status).toBe(200);
    expect((await call("builder", "GET", "/api/projects/finance")).status).toBe(200);
    expect((await call("builder", "GET", "/api/projects")).body.some((p: { slug: string }) => p.slug === "finance")).toBe(true);
  });
});

describe("page versions", () => {
  it("lets project admins delete a version; the newest remaining becomes current", async () => {
    expect((await call("builder", "DELETE", `/api/projects/finance/pages/${financePageId}/versions/1`)).status).toBe(403);
    const v3 = await call("root", "POST", `/api/projects/finance/pages/${financePageId}/versions`, { bundle: page(financePageId, "Board pack v3") });
    expect(v3.body.versionNo).toBe(3);
    const del = await call("root", "DELETE", `/api/projects/finance/pages/${financePageId}/versions/3`);
    expect(del.body).toEqual({ ok: true, currentVersion: 2, pageDeleted: false });
    const pg = await call("root", "GET", `/api/projects/finance/pages/${financePageId}`);
    expect(pg.body.version.versionNo).toBe(2);
    expect(pg.body.meta.title).toBe("Board pack");
    expect((await call("root", "DELETE", `/api/projects/finance/pages/${financePageId}/versions/1`)).body).toEqual({ ok: true, currentVersion: 2, pageDeleted: false });
    const versions = await call("root", "GET", `/api/projects/finance/pages/${financePageId}/versions`);
    expect(versions.body.map((v: { versionNo: number }) => v.versionNo)).toEqual([2]);
    const last = await call("root", "DELETE", `/api/projects/finance/pages/${financePageId}/versions/2`);
    expect(last.status).toBe(409);
    expect((await call("root", "DELETE", `/api/projects/finance/pages/${financePageId}/versions/9`)).status).toBe(404);
    // the next save continues after the newest remaining version
    expect((await call("root", "POST", `/api/projects/finance/pages/${financePageId}/versions`, { bundle: page(financePageId, "Board pack") })).body.versionNo).toBe(3);
  });

  it("admins switch versions off and pick the default; others only see enabled versions", async () => {
    const P = `/api/projects/finance/pages/${financePageId}`;
    // v2 and v3 exist; a new save makes v4 (there is no restore: every edit is a new version)
    expect((await call("root", "POST", `${P}/restore/2`, {})).status).toBe(404);
    expect((await call("builder", "POST", `${P}/versions`, { bundle: page(financePageId, "Board pack v4") })).body.versionNo).toBe(4);
    expect((await call("builder", "PATCH", `${P}/versions/3`, { enabled: false })).status).toBe(403);
    expect((await call("root", "PATCH", `${P}/versions/3`, { enabled: false })).status).toBe(200);
    const adminList = (await call("root", "GET", `${P}/versions`)).body;
    expect(adminList.map((v: { versionNo: number; enabled: boolean }) => [v.versionNo, v.enabled])).toEqual([[4, true], [3, false], [2, true]]);
    const builderList = (await call("builder", "GET", `${P}/versions`)).body;
    expect(builderList.map((v: { versionNo: number }) => v.versionNo)).toEqual([4, 2]);
    expect((await call("builder", "GET", `${P}?version=3`)).status).toBe(404);
    expect((await call("builder", "GET", `${P}/export?version=3`)).status).toBe(404);
    expect((await call("builder", "GET", `${P}/diff?from=3&to=4`)).status).toBe(404);
    expect((await call("root", "GET", `${P}?version=3`)).body.version).toMatchObject({ versionNo: 3, enabled: false });
    // a disabled version cannot become the default; an enabled one can, without a new version
    expect((await call("root", "PUT", `${P}/versions/3/default`, {})).status).toBe(400);
    expect((await call("root", "PUT", `${P}/versions/2/default`, {})).body).toEqual({ ok: true, currentVersion: 2 });
    const pg = (await call("builder", "GET", P)).body;
    expect(pg.meta.currentVersion).toBe(2);
    expect(pg.version.versionNo).toBe(2);
    expect(pg.meta.title).toBe("Board pack");
    // deleting the default falls back to the newest enabled version (v4, not the disabled v3)
    expect((await call("root", "DELETE", `${P}/versions/2`)).body).toEqual({ ok: true, currentVersion: 4, pageDeleted: false });
    expect((await call("root", "PATCH", `${P}/versions/3`, { enabled: true })).status).toBe(200);
    expect((await call("builder", "GET", `${P}/versions`)).body.map((v: { versionNo: number }) => v.versionNo)).toEqual([4, 3]);
    // disabling the default hands it to the newest enabled version; disabling the last one switches the page off for members
    expect((await call("root", "PATCH", `${P}/versions/4`, { enabled: false })).body).toEqual({ ok: true, currentVersion: 3, versionsDisabled: false });
    expect((await call("root", "PATCH", `${P}/versions/3`, { enabled: false })).body).toEqual({ ok: true, currentVersion: 3, versionsDisabled: true });
    const off = await call("builder", "GET", P);
    expect(off.body.meta).toMatchObject({ available: false, versionsDisabled: true });
    expect(off.body.bundle).toBeNull();
    expect((await call("builder", "GET", "/api/projects/finance/pages")).body.find((p: { id: string }) => p.id === financePageId).available).toBe(false);
    const adminView = await call("root", "GET", P);
    expect(adminView.body.meta).toMatchObject({ available: true, versionsDisabled: true });
    expect(adminView.body.bundle).not.toBeNull();
    // enabling a version brings the page back and makes that version the default
    expect((await call("root", "PATCH", `${P}/versions/4`, { enabled: true })).body).toEqual({ ok: true, currentVersion: 4, versionsDisabled: false });
    expect((await call("builder", "GET", P)).body.meta).toMatchObject({ available: true, currentVersion: 4 });
    // leave v3 ("Board pack") enabled and default for the project-package tests that follow
    expect((await call("root", "PATCH", `${P}/versions/3`, { enabled: true })).status).toBe(200);
    expect((await call("root", "PUT", `${P}/versions/3/default`, {})).body).toEqual({ ok: true, currentVersion: 3 });
    expect((await call("root", "GET", P)).body.meta.title).toBe("Board pack");
  });

  it("deleting the only version deletes the page, after confirmation", async () => {
    const created = await call("builder", "POST", "/api/projects/finance/pages", { bundle: page("pg_lastver", "Last version") });
    const P = `/api/projects/finance/pages/${created.body.id}`;
    const refused = await call("root", "DELETE", `${P}/versions/1`);
    expect(refused.status).toBe(409);
    expect(refused.body.details.code).toBe("confirm_page_delete");
    expect((await call("root", "GET", P)).status).toBe(200);
    expect((await call("root", "DELETE", `${P}/versions/1?deletePage=1`)).body).toEqual({ ok: true, currentVersion: 0, pageDeleted: true });
    expect((await call("root", "GET", P)).status).toBe(404);
  });
});

let projectPkg: Buffer;

describe("project packages", () => {
  it("exports settings, skills, sources without credentials, annotations and pages", async () => {
    await call("root", "PATCH", "/api/projects/finance", { settings: { limits: { maxRows: 5000 } } });
    const src = (await call("root", "GET", "/api/projects/finance/sources")).body[0];
    await call("root", "PUT", `/api/projects/finance/sources/${src.id}/annotations`, { glossary: "Revenue excludes tax" });
    expect((await call("builder", "GET", "/api/projects/finance/export")).status).toBe(403);
    const exp = await call("root", "GET", "/api/projects/finance/export");
    expect(exp.status).toBe(200);
    projectPkg = Buffer.from(exp.raw);
    const files = unzipSync(new Uint8Array(projectPkg));
    const all = Object.values(files).map((f) => strFromU8(f)).join("\n");
    expect(all).not.toContain("finance-secret-token");
    const m = JSON.parse(strFromU8(files["manifest.json"]));
    expect(m).toMatchObject({ kind: "project", project: { slug: "finance" } });
    expect(m.pages.map((p: { title: string }) => p.title).sort()).toEqual(["Board pack", "Board pack (copy)"]);
    const sources = JSON.parse(strFromU8(files["sources.json"]));
    expect(sources[0]).toMatchObject({ alias: "api", skill: "datasource-http", credentialMode: "user", config: { baseUrl: "https://ledger.example.com/v1", authType: "bearer" }, annotations: { glossary: "Revenue excludes tax" } });
    // login id, password/token and other secrets are removed, not just masked
    expect(Object.keys(sources[0].config)).not.toContain("token");
    expect(Object.keys(sources[0].config)).not.toContain("username");
    expect(JSON.parse(strFromU8(files["project.json"])).settings.limits.maxRows).toBe(5000);
  });

  it("keeps page and project packages apart", async () => {
    const asPage = await upload("root", "/api/projects/finance/import/analyze", projectPkg, "finance.aibi");
    expect(asPage.status).toBe(400);
    expect(asPage.body.error).toMatch(/is a project package/);
    const asProject = await upload("root", "/api/project-imports/analyze", pagePkg, "board.aibi");
    expect(asProject.status).toBe(400);
    expect(asProject.body.error).toMatch(/is a page package/);
    expect((await upload("builder", "/api/project-imports/analyze", projectPkg, "finance.aibi")).status).toBe(403);
  });

  it("detects the existing project and offers overwrite or a new project", async () => {
    const rep = await upload("root", "/api/project-imports/analyze", projectPkg, "finance.aibi");
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect(rep.body.errors).toEqual([]);
    expect(rep.body.conflict).toMatchObject({ slug: "finance", matchedBy: "id", archived: false });
    expect(rep.body.modes).toEqual(["overwrite", "new"]);
    expect(rep.body.suggestedSlug).toBe("finance-2");
    expect(rep.body.pages.every((p: { action: string }) => p.action === "update")).toBe(true);
    expect(rep.body.sources).toEqual([expect.objectContaining({ alias: "api", action: "update", credentialMode: "user", canKeep: true })]);
    expect(rep.body.sources[0].fields.map((f: { key: string }) => f.key)).toEqual(["username", "token", "clientSecret"]);
  });

  it("imports as a new project only after the entered login is verified", async () => {
    const rep = await upload("root", "/api/project-imports/analyze", projectPkg, "finance.aibi");
    expect(rep.body.sources[0].action).toBe("update");
    const taken = await call("root", "POST", `/api/project-imports/${rep.body.importId}/commit`, { mode: "new", slug: "sales" });
    expect(taken.status).toBe(409);
    // no login: the connection test fails and nothing is created
    const noLogin = await call("root", "POST", `/api/project-imports/${rep.body.importId}/commit`, { mode: "new", slug: "finance-copy", name: "Finance (copy)" });
    expect(noLogin.status).toBe(422);
    expect(noLogin.body.details).toMatchObject({ code: "credentials_invalid", sources: [{ alias: "api", message: expect.stringMatching(/token/) }] });
    expect((await call("root", "GET", "/api/projects/finance-copy")).status).toBe(404);
    const r = await call("root", "POST", `/api/project-imports/${rep.body.importId}/commit`, { mode: "new", slug: "finance-copy", name: "Finance (copy)", credentials: { api: { token: "copy-token" } } });
    expect(r.body).toMatchObject({ slug: "finance-copy", mode: "new", pagesCreated: 2, pagesUpdated: 0, sourcesCreated: 1 });
    const p = await call("root", "GET", "/api/projects/finance-copy");
    expect(p.body).toMatchObject({ name: "Finance (copy)", description: "finance reports" });
    expect(p.body.settings.limits.maxRows).toBe(5000);
    const pages = (await call("root", "GET", "/api/projects/finance-copy/pages")).body as { id: string; title: string }[];
    expect(pages).toHaveLength(2);
    expect(pages.map((x) => x.id)).not.toContain(financePageId);
    const src = (await call("root", "GET", "/api/projects/finance-copy/sources")).body[0];
    // the login entered on import is the importer's personal login, not part of the project settings
    expect(src.config.token).toBeUndefined();
    expect(src.status).toBe("ok");
    const { openSecrets: open } = await import("./lib/crypto");
    const rootId = db.get<{ id: string }>("SELECT id FROM users WHERE email = 'root@example.com'")!.id;
    expect(open(JSON.parse(db.get<{ config: string }>("SELECT config FROM user_source_credentials WHERE instance_id = ? AND user_id = ?", src.id, rootId)!.config), ["token"]).token).toBe("copy-token");
    expect((await call("root", "GET", `/api/projects/finance-copy/sources/${src.id}/schema`)).body.annotations.glossary).toBe("Revenue excludes tax");
    expect((await call("root", "POST", `/api/project-imports/${rep.body.importId}/commit`, { mode: "new", slug: "finance-3" })).status).toBe(400);
  });

  it("overwrites the existing project only after confirmation, keeping credentials and other pages", async () => {
    const extra = await call("root", "POST", "/api/projects/finance/pages", { bundle: page("pg_fin_extra", "Only in target") });
    await call("root", "PATCH", "/api/projects/finance", { name: "Finance renamed", settings: { limits: { maxRows: 99 } } });
    // the import saves a new version after the newest one (which need not be the default)
    const before = Math.max(...(await call("root", "GET", `/api/projects/finance/pages/${financePageId}/versions`)).body.map((v: { versionNo: number }) => v.versionNo));
    const rep = await upload("root", "/api/project-imports/analyze", projectPkg, "finance.aibi");
    expect(rep.body.conflict.pagesKept).toBe(1);
    const noConfirm = await call("root", "POST", `/api/project-imports/${rep.body.importId}/commit`, { mode: "overwrite" });
    expect(noConfirm.status).toBe(409);
    expect(noConfirm.body.details.code).toBe("confirm_overwrite");
    const r = await call("root", "POST", `/api/project-imports/${rep.body.importId}/commit`, { mode: "overwrite", overwrite: true });
    expect(r.body).toMatchObject({ slug: "finance", mode: "overwrite", pagesUpdated: 2, pagesCreated: 0, sourcesUpdated: 1 });
    const p = (await call("root", "GET", "/api/projects/finance")).body;
    expect(p.name).toBe("Finance");
    expect(p.settings.limits.maxRows).toBe(5000);
    expect((await call("root", "GET", `/api/projects/finance/pages/${financePageId}`)).body.version.versionNo).toBe(before + 1);
    expect((await call("root", "GET", `/api/projects/finance/pages/${extra.body.id}`)).status).toBe(200);
    // root's personal token (typed into the settings when the source was created) survived the overwrite
    const { openSecrets } = await import("./lib/crypto");
    const inst = db.get<{ id: string; config: string }>("SELECT id, config FROM skill_instances WHERE project_id = ? AND alias = 'api'", p.id)!;
    expect(JSON.parse(inst.config).token).toBeUndefined();
    const rootId = db.get<{ id: string }>("SELECT id FROM users WHERE email = 'root@example.com'")!.id;
    const mine = db.get<{ config: string }>("SELECT config FROM user_source_credentials WHERE instance_id = ? AND user_id = ?", inst.id, rootId)!;
    expect(openSecrets(JSON.parse(mine.config), ["token"]).token).toBe("finance-secret-token");
  });

  it("can overwrite an archived project, which restores it", async () => {
    expect((await call("root", "DELETE", "/api/projects/finance")).status).toBe(200);
    const rep = await upload("root", "/api/project-imports/analyze", projectPkg, "finance.aibi");
    expect(rep.body.conflict).toMatchObject({ slug: "finance", archived: true });
    const r = await call("root", "POST", `/api/project-imports/${rep.body.importId}/commit`, { mode: "overwrite", overwrite: true });
    expect(r.status).toBe(200);
    expect((await call("builder", "GET", "/api/projects/finance")).status).toBe(200);
  });
});

describe("per-user sign-in for data sources", () => {
  // a tiny API that answers with the caller's token, so each user's data is visibly their own
  let server: import("node:http").Server;
  let base = "";
  let hits = 0;
  let hrSourceId = "";
  beforeAll(async () => {
    const http = await import("node:http");
    server = http.createServer((req, res) => {
      hits++;
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      res.writeHead(token ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(token ? { data: [{ who: token }] } : { error: "no token" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await call("root", "POST", "/api/projects", { name: "HR", slug: "hr" })).status).toBe(200);
    await call("root", "PUT", "/api/projects/hr/skills/datasource-http", { enabled: true });
    const s = await call("root", "POST", "/api/projects/hr/sources", { skill: "datasource-http", name: "HR API", alias: "hr", credentialMode: "user", config: { baseUrl: base, authType: "bearer", endpoints: [{ method: "GET", path: "/me" }] } });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    hrSourceId = s.body.id;
    await call("root", "POST", "/api/projects/hr/members", { email: "builder@example.com", role: "builder" });
  });
  afterAll(() => server?.close());

  const query = (who: string) => call(who, "POST", "/api/projects/hr/query/adhoc", { source: "hr", request: { method: "GET", path: "/me", resultPath: "$.data" } });

  it("never keeps a shared login in per-user mode", async () => {
    const src = (await call("root", "GET", "/api/projects/hr/sources")).body[0];
    expect(src.credentialMode).toBe("user");
    expect(src.config.token).toBeUndefined();
    expect(src.credentialFields.map((f: { key: string }) => f.key)).toEqual(["username", "token"]);
  });

  it("asks a member for their own login before any query", async () => {
    const q = await query("builder");
    expect(q.status).toBe(403);
    expect(q.body.details).toMatchObject({ code: "credentials_required", alias: "hr" });
    const mine = await call("builder", "GET", "/api/projects/hr/my-credentials");
    expect(mine.body).toEqual([expect.objectContaining({ alias: "hr", set: false })]);
  });

  it("saves a login only after a successful connection test", async () => {
    const bad = await call("builder", "PUT", `/api/projects/hr/sources/${hrSourceId}/my-credentials`, { values: { token: "" } });
    expect(bad.body).toMatchObject({ ok: false, saved: false });
    expect((await call("builder", "GET", "/api/projects/hr/my-credentials")).body[0].set).toBe(false);
    const ok = await call("builder", "PUT", `/api/projects/hr/sources/${hrSourceId}/my-credentials`, { values: { token: "bo-token" } });
    expect(ok.body).toMatchObject({ ok: true, saved: true });
    const mine = (await call("builder", "GET", "/api/projects/hr/my-credentials")).body[0];
    expect(mine).toMatchObject({ set: true, status: "ok", values: { token: "••••••••" } });
    expect((await call("builder", "PUT", `/api/projects/hr/sources/${hrSourceId}/my-credentials`, { values: { baseUrl: "http://evil" } })).status).toBe(400);
  });

  it("each user sees data from their own account, never from another user's cache", async () => {
    const b = await query("builder");
    expect(b.body.rows).toEqual([["bo-token"]]);
    expect((await query("root")).status).toBe(403);
    await call("root", "PUT", `/api/projects/hr/sources/${hrSourceId}/my-credentials`, { values: { token: "root-token" } });
    const before = hits;
    const r = await query("root");
    expect(r.body.rows).toEqual([["root-token"]]);
    expect(hits).toBe(before + 1);
    expect((await query("builder")).body.rows).toEqual([["bo-token"]]);
  });

  it("shows admins who has signed in, without the values", async () => {
    expect((await call("builder", "GET", `/api/projects/hr/sources/${hrSourceId}/credentials`)).status).toBe(403);
    const st = (await call("root", "GET", `/api/projects/hr/sources/${hrSourceId}/credentials`)).body as { email: string; set: boolean }[];
    expect(st.map((x) => [x.email, x.set])).toEqual([["builder@example.com", true], ["root@example.com", true]]);
    expect(JSON.stringify(st)).not.toContain("bo-token");
  });

  it("exports per-user mode without anyone's login, and asks the importer for theirs", async () => {
    const exp = await call("root", "GET", "/api/projects/hr/export");
    const files = unzipSync(new Uint8Array(Buffer.from(exp.raw)));
    const text = Object.values(files).map((f) => strFromU8(f)).join("\n");
    expect(text).not.toMatch(/bo-token|root-token/);
    expect(JSON.parse(strFromU8(files["sources.json"]))[0]).toMatchObject({ credentialMode: "user" });
    const rep = await upload("root", "/api/project-imports/analyze", Buffer.from(exp.raw), "hr.aibi");
    expect(rep.body.sources[0]).toMatchObject({ credentialMode: "user", canKeep: true });
    const r = await call("root", "POST", `/api/project-imports/${rep.body.importId}/commit`, { mode: "new", slug: "hr-copy", credentials: { hr: { token: "importer-token" } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const q = await call("root", "POST", "/api/projects/hr-copy/query/adhoc", { source: "hr", request: { method: "GET", path: "/me", resultPath: "$.data" } });
    expect(q.body.rows).toEqual([["importer-token"]]);
    // the importer's login is their own; nobody else inherits it
    const src = (await call("root", "GET", "/api/projects/hr-copy/sources")).body[0];
    expect(src.credentialMode).toBe("user");
    expect(src.config.token).toBeUndefined();
  });

  it("a login typed into the data source settings is personal to the person who typed it", async () => {
    const before = await query("root");
    expect(before.body.rows).toEqual([["root-token"]]);
    // root edits the settings and types a token: it replaces root's own login only
    await call("root", "PATCH", `/api/projects/hr/sources/${hrSourceId}`, { config: { baseUrl: base, authType: "bearer", token: "root-new-token", endpoints: [{ method: "GET", path: "/me" }] } });
    expect((await query("root")).body.rows).toEqual([["root-new-token"]]);
    expect((await query("builder")).body.rows).toEqual([["bo-token"]]);
    const src = (await call("root", "GET", "/api/projects/hr/sources")).body[0];
    expect(src.config.token).toBeUndefined();
    // a shared account cannot be configured at all
    const sw = await call("root", "PATCH", `/api/projects/hr/sources/${hrSourceId}`, { credentialMode: "shared" });
    expect(sw.status).toBe(400);
    expect(sw.body.error).toMatch(/Logins are personal/);
    expect((await call("root", "POST", "/api/projects/hr/sources", { skill: "datasource-http", name: "x", alias: "x2", credentialMode: "shared", config: { baseUrl: base } })).status).toBe(400);
  });

  it("pages follow the project's data source settings: no connection or login settings in a page", async () => {
    const bad = (request: Record<string, unknown>) => ({ page: { id: "pg_bad", title: "Bad", datasets: [{ id: "d", source: "hr", request: { method: "GET", path: "/me", resultPath: "$.data", ...request } }], widgets: [{ id: "t", type: "table", grid: { x: 0, y: 0, w: 6, h: 4 }, dataset: "d", props: {} }] } });
    for (const extra of [{ baseUrl: "http://evil.example" }, { token: "someone-elses" }, { headers: { Authorization: "Bearer x" } }, { headers: { "X-Api-Key": "k" } }, { password: "p" }]) {
      const save = await call("root", "POST", "/api/projects/hr/pages", { bundle: bad(extra) });
      expect(save.status, JSON.stringify(extra)).toBe(422);
      expect(JSON.stringify(save.body.details.errors)).toMatch(/use the project's 'hr' data source settings/);
      const q = await call("root", "POST", "/api/projects/hr/query/adhoc", { source: "hr", request: { method: "GET", path: "/me", ...extra } });
      expect(q.status, JSON.stringify(extra)).toBe(400);
    }
    // ordinary request headers are still fine
    expect((await call("root", "POST", "/api/projects/hr/query/adhoc", { source: "hr", request: { method: "GET", path: "/me", resultPath: "$.data", headers: { "Accept-Language": "en" } } })).status).toBe(200);
  });

  it("the gallery shares page designs only: no data, no logins; each user sees their own data", async () => {
    const created = await call("root", "POST", "/api/projects/hr/pages", { bundle: { page: { id: "pg_hr_me", title: "Who am I", datasets: [{ id: "me", source: "hr", request: { method: "GET", path: "/me", resultPath: "$.data" } }], widgets: [{ id: "t", type: "table", grid: { x: 0, y: 0, w: 6, h: 4 }, dataset: "me", props: {} }] } } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    // asking for sample data while publishing is ignored
    const pub = await call("root", "GET", `/api/projects/hr/pages/${created.body.id}/export?gallery=1&sample=1`);
    expect(pub.status).toBe(200);
    const pubFiles = unzipSync(new Uint8Array(Buffer.from(pub.raw)));
    expect(Object.keys(pubFiles).some((f) => f.startsWith("sample/"))).toBe(false);
    expect(JSON.parse(strFromU8(pubFiles["manifest.json"])).sampleData).toBe(false);
    // a package published before the rule, with a data snapshot, is stripped when served from the gallery
    const old = await call("root", "GET", `/api/projects/hr/pages/${created.body.id}/export?sample=1`);
    expect(Object.keys(unzipSync(new Uint8Array(Buffer.from(old.raw)))).some((f) => f.startsWith("sample/"))).toBe(false); // per-user source: never sampled
    const pkgId = db.get<{ id: string }>("SELECT id FROM packages WHERE page_id = ? AND gallery = 1", created.body.id)!.id;
    const { zipSync, strToU8 } = await import("fflate");
    const files = unzipSync(new Uint8Array(Buffer.from(pub.raw)));
    files["sample/me.json"] = strToU8(JSON.stringify({ columns: [{ name: "who" }], rows: [["root-new-token"]] }));
    files["manifest.json"] = strToU8(JSON.stringify({ ...JSON.parse(strFromU8(files["manifest.json"])), sampleData: true }));
    delete files["CHECKSUMS.json"];
    fs.writeFileSync(db.get<{ storage_path: string }>("SELECT storage_path FROM packages WHERE id = ?", pkgId)!.storage_path, zipSync(files));
    const gallery = (await call("builder", "GET", "/api/projects/hr/gallery")).body as { id: string; title: string }[];
    expect(gallery.map((g) => g.title)).toContain("Who am I");
    const dl = await call("builder", "GET", `/api/projects/hr/packages/${pkgId}/download`);
    const dlText = Object.values(unzipSync(new Uint8Array(Buffer.from(dl.raw)))).map((f) => strFromU8(f)).join("\n");
    expect(dlText).not.toMatch(/root-new-token|bo-token/);
    // the builder imports a copy from the gallery: it runs with the builder's own login
    const rep = await call("builder", "POST", `/api/projects/hr/packages/${pkgId}/analyze`, {});
    expect(rep.body.errors).toEqual([]);
    const copy = await call("builder", "POST", `/api/projects/hr/import/${rep.body.importId}/commit`, { mode: "copy", mapping: {}, title: "Who am I (mine)" });
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    const q = await call("builder", "POST", "/api/projects/hr/query/dataset", { pageId: copy.body.id, datasetId: "me", filters: {} });
    expect(q.body.rows).toEqual([["bo-token"]]);
    const q2 = await call("root", "POST", "/api/projects/hr/query/dataset", { pageId: copy.body.id, datasetId: "me", filters: {} });
    expect(q2.body.rows).toEqual([["root-new-token"]]);
  });

  it("removing a member removes their logins", async () => {
    const builderId = db.get<{ id: string }>("SELECT id FROM users WHERE email = 'builder@example.com'")!.id;
    expect((await call("root", "DELETE", `/api/projects/hr/members/${builderId}`)).status).toBe(200);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_source_credentials WHERE instance_id = ? AND user_id = ?", hrSourceId, builderId)!.n).toBe(0);
  });
});

describe("existing shared logins become personal", () => {
  it("moves a login stored in shared settings to the person who entered it", async () => {
    const { sealSecrets, openSecrets } = await import("./lib/crypto");
    const { personalizeStoredLogins } = await import("./services/sources");
    const p = db.get<{ id: string }>("SELECT id FROM projects WHERE slug = 'sales'")!;
    const builderId = db.get<{ id: string }>("SELECT id FROM users WHERE email = 'builder@example.com'")!.id;
    // an instance from before the rule: shared mode with a login in its settings, last saved by the builder
    db.run(
      "INSERT INTO skill_instances (id, project_id, skill_id, name, alias, description, config, status, credential_mode, created_at, updated_at) VALUES ('ds_legacy', ?, 'datasource-http', 'Legacy', 'legacy', NULL, ?, 'ok', 'shared', ?, ?)",
      p.id, JSON.stringify(sealSecrets({ baseUrl: "https://legacy.example.com", authType: "bearer", token: "legacy-token" }, ["token", "clientSecret"])), db.now(), db.now(),
    );
    db.run("INSERT INTO audit_log (project_id, actor_id, action, target, detail, created_at) VALUES (?,?,?,?,?,?)", p.id, builderId, "source.update", "ds_legacy", null, db.now());
    personalizeStoredLogins();
    const inst = db.get<{ config: string; credential_mode: string }>("SELECT config, credential_mode FROM skill_instances WHERE id = 'ds_legacy'")!;
    expect(inst.credential_mode).toBe("user");
    expect(JSON.parse(inst.config).token).toBeUndefined();
    const mine = db.get<{ config: string }>("SELECT config FROM user_source_credentials WHERE instance_id = 'ds_legacy' AND user_id = ?", builderId)!;
    expect(openSecrets(JSON.parse(mine.config), ["token"]).token).toBe("legacy-token");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_source_credentials WHERE instance_id = 'ds_legacy'")!.n).toBe(1);
  });
});

describe("review fixes: access control", () => {
  let privateId = "";
  let builderToken = "";
  beforeAll(async () => {
    // root's private page in project 'sales' (the builder is a member of sales, see setup)
    const p = await call("root", "POST", "/api/projects/sales/pages", { bundle: page("pg_root_private", "Root private", "api"), visibility: "private" });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    privateId = p.body.id;
    const src = (await call("root", "GET", "/api/projects/sales/sources")).body[0];
    await call("root", "PUT", `/api/projects/sales/sources/${src.id}/my-credentials`, { values: { token: "sales-root" } });
    // issuing keys is for admins; a key held by a low-privilege member is planted directly to prove a key never exceeds its owner's rights
    const { sha256 } = await import("./lib/crypto");
    builderToken = "aibi_pat_builder_test_token_0001";
    const builderId = db.get<{ id: string }>("SELECT id FROM users WHERE login = 'builder@example.com'")!.id;
    const salesId = db.get<{ id: string }>("SELECT id FROM projects WHERE slug = 'sales'")!.id;
    db.run("INSERT INTO api_tokens (id, user_id, project_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('tok_bt', ?, ?, 't', ?, ?, ?, ?, ?)", builderId, salesId, sha256(builderToken), builderToken.slice(0, 14), JSON.stringify(["mcp", "page:import", "query:read"]), new Date(Date.now() + 86400_000).toISOString(), db.now());
  });

  it("render tokens cannot reach a page the user may not view", async () => {
    expect((await call("builder", "GET", `/api/projects/sales/pages/${privateId}`)).status).toBe(404);
    expect((await call("builder", "POST", "/api/projects/sales/render-token", { mode: "page", pageId: privateId })).status).toBe(404);
    // a page id from another project is refused too
    expect((await call("builder", "POST", "/api/projects/sales/render-token", { mode: "page", pageId: financePageId })).status).toBe(404);
    // the owner can still mint and use one
    const ok = await call("root", "POST", "/api/projects/sales/render-token", { mode: "page", pageId: privateId });
    expect(ok.status).toBe(200);
    const r = await app.inject({ method: "GET", url: `/api/render/${ok.body.token}` });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).bundle.page.title).toBe("Root private");
  });

  it("MCP: viewers cannot run ad-hoc queries; builders cannot push over pages they cannot edit", async () => {
    const mcp = async (token: string, name: string, args: Record<string, unknown>) => {
      const r = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
      return JSON.parse(r.body).result?.content?.[0]?.text as string;
    };
    await call("root", "POST", "/api/projects/sales/members", { email: "builder@example.com", role: "viewer" });
    expect(await mcp(builderToken, "preview_query", { source: "api", request: { path: "/x" } })).toMatch(/requires the builder role/);
    expect(await mcp(builderToken, "introspect_schema", { source: "api" })).toMatch(/requires the builder role/);
    expect(await mcp(builderToken, "validate_page", { bundle: page("pg_v", "v"), run_datasets: true })).toMatch(/requires the builder role/);
    await call("root", "POST", "/api/projects/sales/members", { email: "builder@example.com", role: "builder" });
    const push = await mcp(builderToken, "import_page", { bundle: page(privateId, "pwned") });
    expect(push).toMatch(/ERROR/);
    expect((await call("root", "GET", `/api/projects/sales/pages/${privateId}`)).body.meta.title).toBe("Root private");
    // a malformed body does not crash the endpoint
    const bad = await app.inject({ method: "POST", url: "/mcp", payload: "[null]", headers: { authorization: `Bearer ${builderToken}`, "content-type": "application/json" } });
    expect(bad.statusCode).toBe(200);
    expect(JSON.parse(bad.body)[0].error.code).toBe(-32600);
  });

  it("page import never overwrites a page the importer cannot edit, and does not reveal it", async () => {
    const exp = await call("root", "GET", `/api/projects/sales/pages/${privateId}/export`);
    const rep = await upload("builder", "/api/projects/sales/import/analyze", Buffer.from(exp.raw), "p.aibi");
    expect(rep.body.errors).toEqual([]);
    expect(rep.body.conflict).toBeNull();
    expect(rep.body.modes).toEqual(["copy"]);
    expect((await call("builder", "POST", `/api/projects/sales/import/${rep.body.importId}/commit`, { mode: "version", mapping: {}, overwrite: true })).status).toBe(400);
    const copy = await call("builder", "POST", `/api/projects/sales/import/${rep.body.importId}/commit`, { mode: "copy", mapping: {} });
    expect(copy.status).toBe(200);
    expect(copy.body.id).not.toBe(privateId);
    expect((await call("root", "GET", `/api/projects/sales/pages/${privateId}`)).body.version.versionNo).toBe(1);
  });

  it("plain exports are not kept on the server; only gallery packages can be downloaded", async () => {
    const count = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM packages WHERE project_id = (SELECT id FROM projects WHERE slug = 'sales')")!.n;
    const before = count();
    await call("root", "GET", `/api/projects/sales/pages/${privateId}/export`);
    expect(count()).toBe(before);
    const imp = db.get<{ id: string }>("SELECT id FROM packages WHERE kind = 'import' AND project_id = (SELECT id FROM projects WHERE slug = 'sales') ORDER BY created_at DESC LIMIT 1");
    expect(imp).toBeDefined();
    expect((await call("builder", "GET", `/api/projects/sales/packages/${imp!.id}/download`)).status).toBe(404);
    await call("root", "GET", `/api/projects/sales/pages/${privateId}/export?gallery=1`);
    const g = (await call("builder", "GET", "/api/projects/sales/gallery")).body as { id: string }[];
    expect(g.length).toBeGreaterThan(0);
    expect((await call("builder", "GET", `/api/projects/sales/packages/${g[0].id}/download`)).status).toBe(200);
  });

  it("a package cannot plant code in the module store under a registry package name", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const base = page("pg_mod_poison", "Poison");
    const pageDef = { ...base.page, modules: [{ name: "left-pad", version: "1.3.0", source: "registry", registry: "esm.sh" }] };
    const manifest = { spec: "aibi.package/1", name: "p", version: "1.0.0", title: "Poison", exportedAt: new Date().toISOString(), app: { name: "ai-bi", version: "0.1.0" }, kind: "page", page: { id: "pg_mod_poison", file: "page.json" }, requires: { skills: [], sources: [], modules: [{ name: "left-pad", version: "1.3.0", bundled: true, file: "modules/left-pad@1.3.0/e.mjs" }] }, contents: { components: [], scripts: [], assets: [] }, checksums: "CHECKSUMS.json" };
    const files: Record<string, Uint8Array> = {
      "page.json": strToU8(JSON.stringify(pageDef)),
      "modules/left-pad@1.3.0/e.mjs": strToU8("export default () => 1"),
      "manifest.json": strToU8(JSON.stringify(manifest)),
    };
    const rep = await upload("builder", "/api/projects/sales/import/analyze", Buffer.from(zipSync(files)), "poison.aibi");
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect(rep.body.modules).toEqual([expect.objectContaining({ name: "left-pad", status: "fetch" })]);
    expect(db.get("SELECT 1 FROM modules WHERE name = 'left-pad'")).toBeUndefined();
  });

  it("cyclic derived datasets fail fast instead of hanging", async () => {
    const { computeDatasets } = await import("./services/compute");
    const { PageBundle } = await import("@aibi/page-spec");
    const b = PageBundle.parse({ page: { id: "pg_cycle", title: "c", datasets: [{ id: "a", from: ["b"] }, { id: "b", from: ["a"] }, { id: "self", from: ["self"] }] } });
    const user = { id: "u", login: "u@example.com", email: "u@example.com", displayName: null, isPlatformAdmin: false, authProvider: "local" };
    const r = await Promise.race([computeDatasets("prj_x", user, b, { kind: "ai" }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("hung")), 3000))]);
    expect(Object.keys(r.errors).sort()).toEqual(["a", "b", "self"]);
  });

  it("password sign-in is rate limited per account", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "nobody@example.com", password: "wrong" }, headers: { origin: ORIGIN } })).statusCode;
    expect(last).toBe(429);
  });
});

describe("sign in with the AI BI account", () => {
  it("is offered only for skills with a login name and a password", async () => {
    const http = await call("root", "POST", "/api/projects/sales/sources", { skill: "datasource-http", name: "T", alias: "tok", systemLogin: true, config: { baseUrl: "https://x.example.com" } });
    expect(http.status).toBe(400);
    expect(http.body.error).toMatch(/no login name and password fields/);
    await call("root", "PUT", "/api/projects/sales/skills/datasource-mysql", { enabled: true });
    const my = await call("root", "POST", "/api/projects/sales/sources", { skill: "datasource-mysql", name: "Warehouse", alias: "wh", systemLogin: true, config: { host: "127.0.0.1", port: 1, database: "sales" } });
    expect(my.status, JSON.stringify(my.body)).toBe(200);
    expect(my.body).toMatchObject({ credentialMode: "user", systemLogin: true, systemLoginSupported: true });
    const list = (await call("root", "GET", "/api/projects/sales/my-credentials")).body as { alias: string; systemLogin: boolean }[];
    expect(list.find((s) => s.alias === "wh")?.systemLogin).toBe(true);
  });

  it("checks the AI BI password, tries e-mail then local part, and saves only when the source accepts", async () => {
    const src = (await call("root", "GET", "/api/projects/sales/sources")).body.find((s: { alias: string }) => s.alias === "wh");
    const wrong = await call("root", "PUT", `/api/projects/sales/sources/${src.id}/my-credentials/system`, { password: "not-my-password" });
    expect(wrong.status).toBe(401);
    const right = await call("root", "PUT", `/api/projects/sales/sources/${src.id}/my-credentials/system`, { password: "password123" });
    expect(right.status).toBe(200);
    // nothing listens on port 1: both login ids fail the connection test, nothing is saved
    expect(right.body.saved).toBe(false);
    expect(db.get("SELECT 1 FROM user_source_credentials WHERE instance_id = ?", src.id)).toBeUndefined();
    const { systemLoginCandidates } = await import("./services/sources");
    expect(systemLoginCandidates("root@example.com")).toEqual(["root@example.com", "root"]);
    expect(systemLoginCandidates("jsmith", "jane.smith@corp.example.com")).toEqual(["jsmith", "jane.smith@corp.example.com", "jane.smith"]);
  });

  it("AI BI sign-in syncs such sources without ever failing the sign-in; the gate still verifies", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "root@example.com", password: "password123" }, headers: { origin: ORIGIN } });
    expect(r.statusCode).toBe(200);
    const chk = await call("root", "POST", "/api/projects/sales/my-credentials/check", {});
    const wh = chk.body.sources.find((s: { alias: string }) => s.alias === "wh");
    expect(chk.body.ok).toBe(false);
    expect(wh).toMatchObject({ systemLogin: true, set: false, ok: false });
  });

  it("such sources never count towards 'Sign out of data sources'", async () => {
    const src = (await call("root", "GET", "/api/projects/sales/sources")).body.find((s: { alias: string }) => s.alias === "wh");
    const { sealSecrets } = await import("./lib/crypto");
    const rootId = db.get<{ id: string }>("SELECT id FROM users WHERE email = 'root@example.com'")!.id;
    const count = async () => (await call("root", "GET", "/api/auth/me")).body.projects.find((p: { slug: string }) => p.slug === "sales").dataSourceLogins as number;
    const before = await count(); // root's manual login for 'api' counts
    db.run("INSERT INTO user_source_credentials (instance_id, user_id, config, status, status_message, updated_at) VALUES (?,?,?,?,?,?)", src.id, rootId, JSON.stringify(sealSecrets({ user: "root", password: "p" }, ["password"])), "ok", null, db.now());
    expect(await count()).toBe(before);
    const out = await call("root", "DELETE", "/api/projects/sales/my-credentials");
    expect(out.body.removed).toBe(before);
    expect(db.get("SELECT 1 FROM user_source_credentials WHERE instance_id = ?", src.id)).toBeDefined();
    expect(await count()).toBe(0);
  });
});

describe("skills and data sources are per project; disabling a source disables its pages", () => {
  it("an uploaded skill is never enabled by default, whatever its manifest says", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const manifest = { id: "datasource-thirdparty-test", version: "1.0.0", type: "datasource", name: "Third party", description: "test", defaultEnabled: true, capabilities: { kind: "http" }, server: "server/index.mjs", permissions: [] };
    const zip = zipSync({ "skill.json": strToU8(JSON.stringify(manifest)), "SKILL.md": strToU8("### x"), "server/index.mjs": strToU8("export default { datasource: { kind: 'http', async testConnection() { return { ok: true, message: 'ok' }; }, async introspect() { return { schemas: [], endpoints: [] }; }, async query() { return { columns: [], rows: [] }; } } };") });
    const up = await upload("root", "/api/skills/upload", Buffer.from(zip), "tp.zip");
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect((await call("root", "POST", "/api/skills/datasource-thirdparty-test/approve", { version: "1.0.0", approved: true })).status).toBe(200);
    // not assigned to any project yet: no project lists it, and a project admin cannot enable it
    expect((await call("root", "GET", "/api/projects/finance/skills")).body.some((s: { id: string }) => s.id === "datasource-thirdparty-test")).toBe(false);
    expect((await call("root", "PUT", "/api/projects/finance/skills/datasource-thirdparty-test", { enabled: true })).status).toBe(404);
    // built-in defaults still apply
    expect((await call("root", "GET", "/api/projects/finance/skills")).body.find((s: { id: string }) => s.id === "datasource-sqlite").enabled).toBe(true);
    // a platform admin assigns it to one project: only that project sees it (enabled), the other never does
    const finance = (await call("root", "GET", "/api/projects")).body.find((p: { slug: string }) => p.slug === "finance");
    expect((await call("root", "PUT", "/api/skills/datasource-thirdparty-test/projects", { projectIds: [finance.id] })).status).toBe(200);
    const inFinance = (await call("root", "GET", "/api/projects/finance/skills")).body.find((s: { id: string }) => s.id === "datasource-thirdparty-test");
    expect(inFinance).toMatchObject({ source: "uploaded", defaultEnabled: true, enabled: true });
    expect((await call("root", "GET", "/api/projects/sales/skills")).body.some((s: { id: string }) => s.id === "datasource-thirdparty-test")).toBe(false);
    expect((await call("root", "GET", "/api/skills")).body.find((s: { id: string }) => s.id === "datasource-thirdparty-test").projects).toEqual([{ id: finance.id, slug: "finance", name: expect.any(String) }]);
    // the project can switch it off and on, but not share it; un-assigning removes it from the project
    expect((await call("root", "PUT", "/api/projects/finance/skills/datasource-thirdparty-test", { enabled: false })).status).toBe(200);
    expect((await call("root", "GET", "/api/projects/finance/skills")).body.find((s: { id: string }) => s.id === "datasource-thirdparty-test").enabled).toBe(false);
    expect((await call("root", "PUT", "/api/skills/datasource-thirdparty-test/projects", { projectIds: [] })).status).toBe(200);
    expect((await call("root", "GET", "/api/projects/finance/skills")).body.some((s: { id: string }) => s.id === "datasource-thirdparty-test")).toBe(false);
  });

  it("disabling a data source marks its pages unavailable until it is enabled again", async () => {
    const src = (await call("root", "GET", "/api/projects/finance/sources")).body.find((s: { alias: string }) => s.alias === "api");
    const before = (await call("root", "GET", `/api/projects/finance/pages/${financePageId}`)).body.meta;
    expect(before).toMatchObject({ available: true, disabledSources: [], missingSources: [] });
    expect((await call("root", "PATCH", `/api/projects/finance/sources/${src.id}`, { status: "disabled" })).status).toBe(200);
    const during = (await call("root", "GET", `/api/projects/finance/pages/${financePageId}`)).body.meta;
    expect(during).toMatchObject({ available: false, disabledSources: ["api"] });
    const listed = (await call("builder", "GET", "/api/projects/finance/pages")).body.find((p: { id: string }) => p.id === financePageId);
    expect(listed.available).toBe(false);
    // its datasets cannot run while the source is disabled
    const q = await call("root", "POST", "/api/projects/finance/query/dataset", { pageId: financePageId, datasetId: "rows", filters: {} });
    expect(q.status).toBe(400);
    expect(q.body.error).toMatch(/disabled/);
    expect((await call("root", "PATCH", `/api/projects/finance/sources/${src.id}`, { status: "enabled" })).status).toBe(200);
    expect((await call("root", "GET", `/api/projects/finance/pages/${financePageId}`)).body.meta.available).toBe(true);
    // disabling the skill in the project has the same effect
    expect((await call("root", "PUT", "/api/projects/finance/skills/datasource-http", { enabled: false })).status).toBe(200);
    expect((await call("root", "GET", `/api/projects/finance/pages/${financePageId}`)).body.meta).toMatchObject({ available: false, disabledSources: ["api"] });
    await call("root", "PUT", "/api/projects/finance/skills/datasource-http", { enabled: true });
    expect((await call("root", "GET", `/api/projects/finance/pages/${financePageId}`)).body.meta.available).toBe(true);
  });
});

describe("external access keys", () => {
  it("are issued by project admins only", async () => {
    expect((await call("builder", "POST", "/api/me/tokens", { name: "cli", project: "finance", scopes: ["page:read"], days: 7 })).status).toBe(403);
    const r = await call("root", "POST", "/api/me/tokens", { name: "cli", project: "finance", scopes: ["page:read"], days: 7 });
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^aibi_pat_/);
  });
});

describe("platform users", () => {
  it("disabling shows the affected projects and blocks everywhere; removing deletes the account and its memberships", async () => {
    const created = await call("root", "POST", "/api/users", { kind: "form", login: "temp.user", password: "temppass123" });
    const id = created.body.id;
    await call("root", "POST", "/api/projects/finance/members", { kind: "form", login: "temp.user", role: "builder" });
    await call("root", "POST", "/api/projects/sales/members", { kind: "form", login: "temp.user", role: "viewer" });
    const login = async () => { const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "temp.user", password: "temppass123" }, headers: { origin: ORIGIN } }); return { status: r.statusCode, cookie: String(r.headers["set-cookie"]).split(";")[0] }; };
    const s = await login();
    expect(s.status).toBe(200);
    const pg = await app.inject({ method: "POST", url: "/api/projects/finance/pages", payload: { bundle: page("pg_temp_owned", "Temp page") }, headers: { cookie: s.cookie, origin: ORIGIN, "content-type": "application/json" } });
    expect(pg.statusCode).toBe(200);
    const impact = (await call("root", "GET", `/api/users/${id}/projects`)).body;
    expect(impact.projects.map((p: { slug: string; role: string; pages: number }) => [p.slug, p.role, p.pages])).toEqual([["finance", "builder", 1], ["sales", "viewer", 0]]);
    // disabled on the platform: signed out, cannot sign in, shown as such in each project
    expect((await call("root", "PATCH", `/api/users/${id}`, { disabled: true })).status).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: s.cookie, origin: ORIGIN } })).statusCode).toBe(401);
    expect((await login()).status).toBe(401);
    expect((await call("root", "GET", "/api/projects/finance/members")).body.find((m: { userId: string }) => m.userId === id)).toMatchObject({ enabled: true, platformDisabled: true });
    expect((await call("root", "PATCH", `/api/users/${id}`, { disabled: false })).status).toBe(200);
    expect((await login()).status).toBe(200);
    // removal: memberships gone, the page passes to the acting admin, the login id is free again
    expect((await call("root", "DELETE", `/api/users/${id}`)).body).toEqual({ ok: true, projects: 2 });
    expect((await call("root", "GET", "/api/projects/finance/members")).body.some((m: { userId: string }) => m.userId === id)).toBe(false);
    expect((await call("root", "GET", `/api/projects/finance/pages/${pg.json().id}`)).body.meta.owner.login).toBe("root@example.com");
    expect((await call("root", "GET", "/api/users/check?login=temp.user")).body).toEqual({ exists: false });
    // the other direction never touches the account: a project-level disable or removal leaves the platform user as it is
    const other = await call("root", "POST", "/api/users", { kind: "form", login: "proj.only", password: "projpass123" });
    await call("root", "POST", "/api/projects/finance/members", { kind: "form", login: "proj.only", role: "viewer" });
    await call("root", "POST", "/api/projects/sales/members", { kind: "form", login: "proj.only", role: "viewer" });
    expect((await call("root", "PATCH", `/api/projects/finance/members/${other.body.id}`, { enabled: false })).status).toBe(200);
    expect((await call("root", "GET", "/api/users")).body.find((u: { id: string }) => u.id === other.body.id).disabled).toBe(false);
    const po = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "proj.only", password: "projpass123" }, headers: { origin: ORIGIN } });
    expect(po.statusCode).toBe(200);
    const poProjects = (await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: String(po.headers["set-cookie"]).split(";")[0], origin: ORIGIN } })).json();
    expect(poProjects.map((p: { slug: string }) => p.slug)).toEqual(["sales"]);
    expect((await call("root", "DELETE", `/api/projects/sales/members/${other.body.id}`)).status).toBe(200);
    expect((await call("root", "GET", "/api/users")).body.some((u: { id: string }) => u.id === other.body.id)).toBe(true);
    expect((await call("root", "GET", `/api/users/${other.body.id}/projects`)).body.projects.map((p: { slug: string }) => p.slug)).toEqual(["finance"]);
    await call("root", "DELETE", `/api/users/${other.body.id}`);
    // guards: not yourself, not the only platform admin
    const rootId = (await call("root", "GET", "/api/auth/me")).body.user.id;
    expect((await call("root", "DELETE", `/api/users/${rootId}`)).status).toBe(400);
    expect((await call("root", "PATCH", `/api/users/${rootId}`, { disabled: true })).status).toBe(400);
  });
});

describe("form users with a login id", () => {
  it("members are added by login id, email is optional, and they sign in with either", async () => {
    const add = await call("root", "POST", "/api/projects/finance/members", { kind: "form", login: "kim.lee", role: "viewer", name: "Kim Lee", password: "kimpass123" });
    expect(add.body).toMatchObject({ ok: true, login: "kim.lee", email: null });
    expect((await call("root", "POST", "/api/projects/finance/members", { kind: "form", login: "has space", role: "viewer" })).status).toBe(400);
    const login = (id: string, password: string) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email: id, password }, headers: { origin: ORIGIN } });
    expect((await login("kim.lee", "kimpass123")).statusCode).toBe(200);
    expect((await login("KIM.LEE", "kimpass123")).statusCode).toBe(200);
    expect((await login("kim.lee", "nope")).statusCode).toBe(401);
    // a second member with the same login id is the same user; an email can be added later and used to sign in
    expect((await call("root", "POST", "/api/projects/sales/members", { kind: "form", login: "kim.lee", email: "kim@example.com", role: "viewer" })).body.userId).toBe(add.body.userId);
    // a new form user without a password is refused, in projects and in the platform user list
    expect((await call("root", "POST", "/api/projects/sales/members", { kind: "form", login: "no.pass", role: "viewer" })).status).toBe(400);
    expect((await call("root", "POST", "/api/users", { kind: "form", login: "no.pass" })).status).toBe(400);
    expect((await login("builder@example.com", "password123")).statusCode).toBe(200);
    const me = (await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookies.builder, origin: ORIGIN } })).json();
    expect(me.user).toMatchObject({ login: "builder@example.com", email: "builder@example.com" });
    // names: the user changes their own, admins change a member's
    expect((await call("builder", "POST", "/api/me/profile", { name: "Bo B." })).status).toBe(200);
    expect((await call("builder", "GET", "/api/auth/me")).body.user.displayName).toBe("Bo B.");
    expect((await call("root", "PATCH", `/api/projects/finance/members/${add.body.userId}`, { name: "Kim L." })).status).toBe(200);
    expect((await call("root", "GET", "/api/projects/finance/members")).body.find((m: { userId: string }) => m.userId === add.body.userId).name).toBe("Kim L.");
    // a forgotten password: a project admin (or platform admin) sets a new one; the old sessions are gone
    const kim = await login("kim.lee", "kimpass123");
    const kimCookie = String(kim.headers["set-cookie"]).split(";")[0];
    expect((await call("builder", "POST", `/api/projects/finance/members/${add.body.userId}/password`, { password: "newpass123" })).status).toBe(403);
    expect((await call("root", "POST", `/api/projects/finance/members/${add.body.userId}/password`, { password: "newpass123" })).status).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: kimCookie, origin: ORIGIN } })).statusCode).toBe(401);
    expect((await login("kim.lee", "kimpass123")).statusCode).toBe(401);
    expect((await login("kim.lee", "newpass123")).statusCode).toBe(200);
    expect((await call("root", "POST", `/api/users/${add.body.userId}/password`, { password: "another123" })).status).toBe(200);
    expect((await login("kim.lee", "another123")).statusCode).toBe(200);
  });
});

describe("Active Directory users", () => {
  it("AD members are added by user id and sign in through the directory; form users change their own password", async () => {
    // a fake directory in place of the LDAP client: the routes and the user model are what is tested here
    const { getSkill } = await import("./skills/registry");
    const skill = getSkill("auth-ldap")!;
    const directory: Record<string, { password: string; email: string; displayName: string }> = { jsmith: { password: "Secret!1", email: "jsmith@corp.example.com", displayName: "Jane Smith" } };
    const ident = (login: string) => {
      const id = login.replace(/@.*$/, "").toLowerCase();
      const u = directory[id];
      return u ? { externalId: id, email: u.email, displayName: u.displayName } : null;
    };
    skill.server!.auth = {
      providers: () => [{ id: "ldap", label: "Active Directory", kind: "password" }],
      lookup: async (_s, login) => ident(login),
      verifyPassword: async (_s, login, password) => (directory[login.replace(/@.*$/, "").toLowerCase()]?.password === password ? ident(login) : null),
      test: async () => ({ ok: true, message: "fake directory" }),
    };
    // off by default: AD members cannot be added
    expect((await call("root", "POST", "/api/projects/finance/members", { kind: "ad", login: "jsmith", role: "viewer" })).status).toBe(400);
    expect((await call("root", "PUT", "/api/system-skills/auth-ldap", { enabled: true, settings: { url: "ldap://dc1.corp.example.com", baseDn: "DC=corp,DC=example,DC=com" } })).status).toBe(200);
    expect((await call("root", "POST", "/api/system-skills/auth-ldap/test", { settings: {} })).body).toMatchObject({ ok: true });
    expect((await call("root", "GET", "/api/config")).body.providers.some((p: { id: string }) => p.id === "ldap")).toBe(true);
    // added by user id: email and name come from the directory, no password is stored
    const add = await call("root", "POST", "/api/projects/finance/members", { kind: "ad", login: "JSmith", role: "viewer" });
    expect(add.body).toMatchObject({ ok: true, login: "jsmith", email: "jsmith@corp.example.com" });
    expect((await call("root", "POST", "/api/projects/finance/members", { kind: "ad", login: "nobody", role: "viewer" })).status).toBe(400);
    const member = (await call("root", "GET", "/api/projects/finance/members")).body.find((m: { email: string }) => m.email === "jsmith@corp.example.com");
    expect(member).toMatchObject({ kind: "ad", login: "jsmith", role: "viewer", name: "Jane Smith" });
    expect(db.get<{ password_hash: string | null; auth_provider: string }>("SELECT password_hash, auth_provider FROM users WHERE id = ?", add.body.userId)).toEqual({ password_hash: null, auth_provider: "ldap" });
    // platform admins create AD users the same way (the directory supplies email and name)
    const pu = await call("root", "POST", "/api/users", { kind: "ad", login: "jsmith" });
    expect(pu.body.id).toBe(add.body.userId);
    expect((await call("root", "POST", "/api/users", { kind: "ad", login: "nobody" })).status).toBe(400);
    // sign in with the user id or the email; the directory decides
    const login = (id: string, password: string) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email: id, password }, headers: { origin: ORIGIN } });
    expect((await login("jsmith", "wrong")).statusCode).toBe(401);
    const ok = await login("jsmith", "Secret!1");
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers["set-cookie"]).split(";")[0];
    const me = (await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie, origin: ORIGIN } })).json();
    expect(me.user).toMatchObject({ email: "jsmith@corp.example.com", authProvider: "ldap" });
    expect(me.projects.map((p: { slug: string }) => p.slug)).toContain("finance");
    expect((await login("jsmith@corp.example.com", "Secret!1")).statusCode).toBe(200);
    // the id is unique across kinds: a form user cannot take an AD user's id, nor the other way round
    const dupForm = await call("root", "POST", "/api/projects/finance/members", { kind: "form", login: "jsmith", role: "viewer", password: "whatever123" });
    expect(dupForm.status).toBe(409);
    expect(dupForm.body.details.code).toBe("login_taken");
    expect((await call("root", "POST", "/api/users", { kind: "form", login: "JSMITH", password: "whatever123" })).status).toBe(409);
    directory["kim.lee"] = { password: "x", email: "kim.lee@corp.example.com", displayName: "Kim (AD)" };
    expect((await call("root", "POST", "/api/projects/finance/members", { kind: "ad", login: "kim.lee", role: "viewer" })).status).toBe(409);
    expect((await call("root", "POST", "/api/users", { kind: "ad", login: "kim.lee" })).status).toBe(409);
    delete directory["kim.lee"];
    expect((await call("root", "GET", "/api/users/check?login=JSmith")).body).toMatchObject({ exists: true, kind: "ad", login: "jsmith" });
    expect((await call("root", "GET", "/api/users/check?login=kim.lee")).body).toMatchObject({ exists: true, kind: "form" });
    expect((await call("root", "GET", "/api/users/check?login=free.id")).body).toEqual({ exists: false });
    expect((await call("builder", "GET", "/api/users/check?login=free.id")).status).toBe(403);
    // nobody can set a password for an AD user
    expect((await call("root", "POST", `/api/users/${add.body.userId}/password`, { password: "whatever123" })).status).toBe(400);
    // AD users have no password here; form users change theirs
    expect((await app.inject({ method: "POST", url: "/api/me/password", payload: { current: "x", next: "longenough1" }, headers: { cookie, origin: ORIGIN, "content-type": "application/json" } })).statusCode).toBe(400);
    expect((await call("builder", "POST", "/api/me/password", { current: "password123", next: "password1234" })).status).toBe(200);
    expect((await call("builder", "POST", "/api/me/password", { current: "password1234", next: "password123" })).status).toBe(200);
    // with AD on, password sign-in may be switched off; AD sign-in still works, form sign-in does not
    expect((await call("root", "PUT", "/api/system-skills/auth-local", { enabled: false, settings: {} })).status).toBe(200);
    expect((await login("jsmith", "Secret!1")).statusCode).toBe(200);
    expect((await login("builder@example.com", "password123")).statusCode).toBe(403);
    await call("root", "PUT", "/api/system-skills/auth-local", { enabled: true, settings: {} });
    await call("root", "PUT", "/api/system-skills/auth-ldap", { enabled: false, settings: {} });
  });
});
