import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

// a fresh, isolated data directory: the database starts at schema 1 (an "old" installation)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aibi-upgrade-"));
process.env.AIBI_DATA_DIR = tmp;
process.env.AIBI_SECRET = "test-secret";

let db: typeof import("./db");

beforeAll(async () => {
  db = await import("./db");
  db.db.exec("CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.db.exec(db.MIGRATIONS[0] as string);
  db.run("INSERT INTO _migrations (n, applied_at) VALUES (1, ?)", db.now());
  // data an older version would have stored
  db.run("INSERT INTO users (id, email, display_name, password_hash, auth_provider, is_platform_admin, created_at) VALUES ('usr_old', 'old@example.com', 'Old', 'x', 'local', 1, ?)", db.now());
  db.run("INSERT INTO projects (id, slug, name, description, settings, created_by, created_at) VALUES ('prj_old', 'old', 'Old project', NULL, '{}', 'usr_old', ?)", db.now());
  db.run("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES ('prj_old', 'usr_old', 'admin', ?)", db.now());
  db.run("INSERT INTO skill_instances (id, project_id, skill_id, name, alias, description, config, status, created_at, updated_at) VALUES ('ds_old', 'prj_old', 'datasource-sqlite', 'Old DB', 'olddb', NULL, '{\"file\":\"x.db\"}', 'ok', ?, ?)", db.now(), db.now());
  db.run("INSERT INTO pages (id, project_id, title, description, tags, visibility, owner_id, current_version, created_at, updated_at) VALUES ('pg_old', 'prj_old', 'Old page', NULL, '[]', 'project', 'usr_old', 2, ?, ?)", db.now(), db.now());
  for (const n of [1, 2]) db.run("INSERT INTO page_versions (page_id, version_no, bundle, requires, message, source, created_by, created_at) VALUES ('pg_old', ?, ?, '{}', 'v', 'manual', 'usr_old', ?)", n, JSON.stringify({ page: { id: "pg_old", title: `Old page v${n}` }, components: {}, scripts: {}, assets: {} }), db.now());
});

describe("upgrading keeps existing projects and pages", () => {
  it("applies the newer schema in place, keeps every row, and leaves a backup first", () => {
    const logs: string[] = [];
    expect(db.get("SELECT 1 FROM pragma_table_info('skill_instances') WHERE name = 'credential_mode'")).toBeUndefined();
    db.migrate({ log: (m) => logs.push(m) });
    expect(db.all<{ n: number }>("SELECT n FROM _migrations ORDER BY n").map((r) => r.n)).toEqual(db.MIGRATIONS.map((_, i) => i + 1));
    // the users table was rebuilt: the login id is the old email, memberships still point at the user
    expect(db.get<{ login: string; email: string }>("SELECT login, email FROM users WHERE id = 'usr_old'")).toEqual({ login: "old@example.com", email: "old@example.com" });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_members WHERE user_id = 'usr_old'")!.n).toBe(1);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    // new columns and tables exist, old data is untouched
    expect(db.get("SELECT 1 FROM pragma_table_info('skill_instances') WHERE name = 'credential_mode'")).toBeDefined();
    expect(db.get("SELECT 1 FROM pragma_table_info('skill_instances') WHERE name = 'system_login'")).toBeDefined();
    expect(db.get("SELECT 1 FROM sqlite_master WHERE name = 'user_source_credentials'")).toBeDefined();
    expect(db.get<{ name: string }>("SELECT name FROM projects WHERE id = 'prj_old'")?.name).toBe("Old project");
    expect(db.get<{ title: string; current_version: number }>("SELECT title, current_version FROM pages WHERE id = 'pg_old'")).toEqual({ title: "Old page", current_version: 2 });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE page_id = 'pg_old'")!.n).toBe(2);
    expect(JSON.parse(db.get<{ bundle: string }>("SELECT bundle FROM page_versions WHERE page_id = 'pg_old' AND version_no = 2")!.bundle).page.title).toBe("Old page v2");
    expect(db.get<{ credential_mode: string; system_login: number }>("SELECT credential_mode, system_login FROM skill_instances WHERE id = 'ds_old'")).toEqual({ credential_mode: "shared", system_login: 0 });
    // a backup of the pre-upgrade database was written and is a readable copy
    const backups = fs.readdirSync(path.join(tmp, "backups")).filter((f) => f.endsWith(".db"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/before-schema-2\.db$/);
    expect(logs.join("\n")).toMatch(/backed up/);
    expect(fs.statSync(path.join(tmp, "backups", backups[0])).size).toBeGreaterThan(0);
    // running again is a no-op: no new backup, nothing changes
    db.migrate();
    expect(fs.readdirSync(path.join(tmp, "backups")).filter((f) => f.endsWith(".db"))).toHaveLength(1);
  });

  it("refuses to run an older build against a newer database", () => {
    db.run("INSERT INTO _migrations (n, applied_at) VALUES (?, ?)", db.MIGRATIONS.length + 5, db.now());
    expect(() => db.migrate()).toThrow(/newer version/);
    db.run("DELETE FROM _migrations WHERE n > ?", db.MIGRATIONS.length);
  });

  it("the backup command copies the database, the key and the data folders", async () => {
    fs.writeFileSync(path.join(tmp, ".secret"), "k");
    fs.mkdirSync(path.join(tmp, "packages"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "packages", "p.aibi"), "zip");
    const { execFileSync } = await import("node:child_process");
    const out = path.join(tmp, "bk");
    const res = execFileSync(process.execPath, [path.resolve(__dirname, "../../../tools/backup.mjs"), out], { env: { ...process.env, AIBI_DATA_DIR: tmp }, encoding: "utf8" });
    expect(res).toMatch(/backup written/);
    for (const f of ["aibi.db", ".secret", "packages/p.aibi", "BACKUP.json"]) expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    // the test runner rewrites "node:sqlite" imports; load it like the server does
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const copy = new DatabaseSync(path.join(out, "aibi.db"), { readOnly: true });
    expect((copy.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number }).n).toBe(1);
    copy.close();
  });
});
