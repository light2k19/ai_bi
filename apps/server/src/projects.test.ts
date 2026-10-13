import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";

// isolate the data directory before the config module loads
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aibi-projects-"));
process.env.AIBI_DATA_DIR = tmp;
process.env.AIBI_SECRET = "test-secret";

let app: FastifyInstance;
let db: typeof import("./db");
const cookies: Record<string, string> = {};

async function call(who: string, method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie: cookies[who] ?? "", origin: "http://localhost:5173", ...(payload !== undefined ? { "content-type": "application/json" } : {}) } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}

beforeAll(async () => {
  db = await import("./db");
  db.migrate();
  const { loadSkills } = await import("./skills/registry");
  await loadSkills();
  const { hashPassword, newId } = await import("./lib/crypto");
  for (const [email, admin] of [["root@example.com", 1], ["owner@example.com", 0], ["member@example.com", 0]] as const) {
    db.run("INSERT INTO users (id, login, email, display_name, password_hash, auth_provider, is_platform_admin, created_at) VALUES (?,?,?,?,?,?,?,?)", newId("usr"), email, email, email, hashPassword("password123"), "local", admin, db.now());
  }
  const { buildApp } = await import("./app");
  app = await buildApp();
  for (const who of ["root", "owner", "member"]) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@example.com`, password: "password123" }, headers: { origin: "http://localhost:5173" } });
    expect(r.statusCode).toBe(200);
    cookies[who] = String(r.headers["set-cookie"]).split(";")[0];
  }
});
afterAll(async () => {
  await app?.close();
});

describe("project lifecycle", () => {
  it("edits name, slug and description; validates and rejects taken slugs", async () => {
    expect((await call("root", "POST", "/api/projects", { name: "Alpha", slug: "alpha" })).status).toBe(200);
    expect((await call("root", "POST", "/api/projects", { name: "Beta", slug: "beta" })).status).toBe(200);
    expect((await call("root", "POST", "/api/projects/alpha/members", { email: "owner@example.com", role: "admin" })).status).toBe(200);
    expect((await call("root", "POST", "/api/projects/alpha/members", { email: "member@example.com", role: "viewer" })).status).toBe(200);

    const r = await call("owner", "PATCH", "/api/projects/alpha", { name: "Alpha Finance", slug: "alpha-fin", description: "Finance pack" });
    expect(r).toEqual({ status: 200, body: { ok: true, slug: "alpha-fin" } });
    const p = await call("owner", "GET", "/api/projects/alpha-fin");
    expect(p.body).toMatchObject({ name: "Alpha Finance", slug: "alpha-fin", description: "Finance pack" });
    expect((await call("owner", "GET", "/api/projects/alpha")).status).toBe(404);

    expect((await call("owner", "PATCH", "/api/projects/alpha-fin", { slug: "beta" })).status).toBe(409);
    expect((await call("owner", "PATCH", "/api/projects/alpha-fin", { slug: "Bad Slug" })).status).toBe(400);
    expect((await call("owner", "PATCH", "/api/projects/alpha-fin", { name: "  " })).status).toBe(400);
    expect((await call("member", "PATCH", "/api/projects/alpha-fin", { name: "x" })).status).toBe(403);
    // a failed slug change leaves the name untouched (one transaction)
    expect((await call("owner", "PATCH", "/api/projects/alpha-fin", { name: "Renamed", slug: "beta" })).status).toBe(409);
    expect((await call("owner", "GET", "/api/projects/alpha-fin")).body.name).toBe("Alpha Finance");
  });

  it("archives (platform admin only), lists archived, and restores", async () => {
    expect((await call("owner", "DELETE", "/api/projects/alpha-fin")).status).toBe(403);
    expect((await call("root", "DELETE", "/api/projects/alpha-fin")).status).toBe(200);
    expect((await call("member", "GET", "/api/projects/alpha-fin")).status).toBe(404);
    const me = await call("member", "GET", "/api/auth/me");
    expect(me.body.projects.map((p: { slug: string }) => p.slug)).not.toContain("alpha-fin");

    expect((await call("owner", "GET", "/api/projects/archived")).status).toBe(403);
    const arch = await call("root", "GET", "/api/projects/archived");
    expect(arch.body).toEqual([expect.objectContaining({ slug: "alpha-fin", name: "Alpha Finance", members: 3, pages: 0, sources: 0 })]);

    expect((await call("owner", "POST", "/api/projects/alpha-fin/restore", {})).status).toBe(403);
    expect((await call("root", "POST", "/api/projects/alpha-fin/restore", {})).body).toEqual({ ok: true, slug: "alpha-fin" });
    expect((await call("member", "GET", "/api/projects/alpha-fin")).status).toBe(200);
    expect((await call("root", "POST", "/api/projects/alpha-fin/restore", {})).status).toBe(400);
  });

  it("deletes permanently with a typed confirmation and removes dependent data and files", async () => {
    const pid = (await call("root", "GET", "/api/projects/alpha-fin")).body.id as string;
    const page = await call("owner", "POST", "/api/projects/alpha-fin/pages", { title: "Board pack" });
    expect(page.status).toBe(200);
    const pkgFile = path.join(tmp, "packages", "alpha-test.aibi");
    fs.mkdirSync(path.dirname(pkgFile), { recursive: true });
    fs.writeFileSync(pkgFile, "x");
    db.run("INSERT INTO packages (id, project_id, page_id, version_no, manifest, storage_path, size, kind, gallery, created_by, created_at) VALUES ('pkg_t', ?, ?, 1, '{}', ?, 1, 'export', 0, NULL, ?)", pid, page.body.id, pkgFile, db.now());
    db.run("INSERT INTO query_log (project_id, instance_id, user_id, page_id, kind, request, duration_ms, rows, status, error, created_at) VALUES (?, NULL, NULL, NULL, 'adhoc', '{}', 1, 0, 'ok', NULL, ?)", pid, db.now());

    expect((await call("owner", "POST", "/api/projects/alpha-fin/delete", { confirm: "alpha-fin" })).status).toBe(403);
    const wrong = await call("root", "POST", "/api/projects/alpha-fin/delete", { confirm: "alpha" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/Type the project slug 'alpha-fin'/);

    const del = await call("root", "POST", "/api/projects/alpha-fin/delete", { confirm: "alpha-fin" });
    expect(del.body).toMatchObject({ ok: true, pages: 1, sources: 0, members: 3, files: 1 });
    expect(fs.existsSync(pkgFile)).toBe(false);
    for (const t of ["projects WHERE id", "pages WHERE project_id", "page_versions WHERE page_id IN (SELECT id FROM pages WHERE project_id", "project_members WHERE project_id", "packages WHERE project_id", "query_log WHERE project_id"]) {
      const sql = `SELECT COUNT(*) AS n FROM ${t} = ?${t.includes("IN (") ? ")" : ""}`;
      expect(db.get<{ n: number }>(sql, pid)!.n, t).toBe(0);
    }
    const auditRows = db.all<{ action: string }>("SELECT action FROM audit_log WHERE project_id = ? ORDER BY id", pid).map((r) => r.action);
    expect(auditRows).toContain("project.delete");
    expect((await call("root", "GET", "/api/projects/alpha-fin")).status).toBe(404);
    // the slug is free again
    expect((await call("root", "POST", "/api/projects", { name: "Alpha again", slug: "alpha-fin" })).status).toBe(200);
  });

  it("can delete an archived project directly", async () => {
    expect((await call("root", "DELETE", "/api/projects/beta")).status).toBe(200);
    expect((await call("root", "POST", "/api/projects/beta/delete", { confirm: "beta" })).body.ok).toBe(true);
    expect((await call("root", "GET", "/api/projects/archived")).body).toEqual([]);
  });
});
