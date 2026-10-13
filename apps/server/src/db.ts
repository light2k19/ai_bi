import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncT, SQLInputValue } from "node:sqlite";

// loaded through require so test runners that rewrite `node:` imports (vite-node) still find it
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSyncT };
import { config } from "./config";

export const db = new DatabaseSync(config.dbFile);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

type P = SQLInputValue;
const norm = (args: unknown[]): P[] => args.map((a) => (a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : (a as P)));

export function all<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T[] {
  return db.prepare(sql).all(...norm(args)) as T[];
}
export function get<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T | undefined {
  return db.prepare(sql).get(...norm(args)) as T | undefined;
}
export function run(sql: string, ...args: unknown[]) {
  return db.prepare(sql).run(...norm(args));
}
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export const json = (v: unknown) => JSON.stringify(v ?? null);
export function parse<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
export const now = () => new Date().toISOString();

/** SQL to apply, or a function for changes SQL alone cannot express (a table rebuild). */
export const MIGRATIONS: (string | (() => void))[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT,
    password_hash TEXT,
    auth_provider TEXT NOT NULL DEFAULT 'local',
    external_id TEXT,
    is_platform_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin','builder','viewer')),
    added_at TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE skills (
    id TEXT NOT NULL,
    version TEXT NOT NULL,
    type TEXT NOT NULL,
    manifest TEXT NOT NULL,
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 1,
    checksum TEXT,
    installed_at TEXT NOT NULL,
    PRIMARY KEY (id, version)
  );
  CREATE TABLE system_skill_settings (
    skill_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    settings TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE project_skills (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    settings TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (project_id, skill_id)
  );
  CREATE TABLE skill_instances (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL,
    name TEXT NOT NULL,
    alias TEXT NOT NULL,
    description TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'new',
    status_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, alias)
  );
  CREATE TABLE datasource_schemas (
    instance_id TEXT PRIMARY KEY REFERENCES skill_instances(id) ON DELETE CASCADE,
    snapshot TEXT,
    annotations TEXT NOT NULL DEFAULT '{}',
    captured_at TEXT
  );
  CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    visibility TEXT NOT NULL DEFAULT 'project',
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pages_project ON pages(project_id, deleted);
  CREATE TABLE page_versions (
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL,
    bundle TEXT NOT NULL,
    requires TEXT NOT NULL DEFAULT '{}',
    message TEXT,
    source TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    ai_session_id TEXT,
    PRIMARY KEY (page_id, version_no)
  );
  CREATE TABLE module_files (
    hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    origin_url TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE modules (
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    hash TEXT NOT NULL REFERENCES module_files(hash),
    integrity TEXT NOT NULL,
    source TEXT NOT NULL,
    url TEXT,
    provides_widgets TEXT NOT NULL DEFAULT '[]',
    files TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    PRIMARY KEY (name, version)
  );
  CREATE TABLE project_modules (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved',
    added_by TEXT,
    added_at TEXT NOT NULL,
    PRIMARY KEY (project_id, name, version)
  );
  CREATE TABLE packages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_id TEXT,
    version_no INTEGER,
    manifest TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'export',
    gallery INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE imports (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    report TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'analyzed',
    created_at TEXT NOT NULL
  );
  CREATE TABLE ai_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_id TEXT,
    user_id TEXT NOT NULL,
    title TEXT,
    messages TEXT NOT NULL DEFAULT '[]',
    usage TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    user_id TEXT,
    session_id TEXT,
    kind TEXT NOT NULL,
    model TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scopes TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE query_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    instance_id TEXT,
    user_id TEXT,
    page_id TEXT,
    kind TEXT NOT NULL,
    request TEXT,
    duration_ms INTEGER,
    rows INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX query_log_project ON query_log(project_id, created_at);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    actor_id TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX audit_log_project ON audit_log(project_id, created_at);
  CREATE TABLE oidc_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    data TEXT NOT NULL,
    return_to TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE narrative_cache (
    key TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // 2: per-user sign-in for data sources
  `
  ALTER TABLE skill_instances ADD COLUMN credential_mode TEXT NOT NULL DEFAULT 'shared';
  CREATE TABLE user_source_credentials (
    instance_id TEXT NOT NULL REFERENCES skill_instances(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    config TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    status_message TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (instance_id, user_id)
  );
  `,
  // 3: data sources that members sign in to with their AI BI account
  `ALTER TABLE skill_instances ADD COLUMN system_login INTEGER NOT NULL DEFAULT 0;`,
  // 4: third-party skills belong to the projects they are assigned to; a disabled row from the time they were
  // listed everywhere would now count as an assignment, so only projects that enabled or use them keep one
  `DELETE FROM project_skills WHERE enabled = 0 AND skill_id IN (SELECT id FROM skills WHERE source <> 'builtin')
     AND NOT EXISTS (SELECT 1 FROM skill_instances si WHERE si.project_id = project_skills.project_id AND si.skill_id = project_skills.skill_id);`,
  // 5: page versions an admin switched off: only admins see and use them
  `ALTER TABLE page_versions ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;`,
  // 6: members an admin switched off keep their role and pages but cannot see the project
  `ALTER TABLE project_members ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;`,
  // 7: users sign in with a login id (any id for form users, the Windows id for AD users); email is optional.
  // SQLite cannot drop NOT NULL, so the table is rebuilt; foreign keys are off while it is (see migrate()).
  () => {
    db.exec(`
      CREATE TABLE users_v7 (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT UNIQUE COLLATE NOCASE,
        display_name TEXT,
        password_hash TEXT,
        auth_provider TEXT NOT NULL DEFAULT 'local',
        external_id TEXT,
        is_platform_admin INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );
      INSERT INTO users_v7 (id, login, email, display_name, password_hash, auth_provider, external_id, is_platform_admin, disabled, created_at, last_login_at)
        SELECT id, CASE WHEN auth_provider = 'ldap' AND external_id IS NOT NULL THEN external_id ELSE email END, email, display_name, password_hash, auth_provider, external_id, is_platform_admin, disabled, created_at, last_login_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_v7 RENAME TO users;
    `);
  },
  // 8: AI commentary is kept until the data changes, someone regenerates it or the page is edited (no time limit)
  `DELETE FROM narrative_cache;
   ALTER TABLE narrative_cache ADD COLUMN page_id TEXT;
   ALTER TABLE narrative_cache ADD COLUMN last_used_at TEXT;
   CREATE INDEX narrative_cache_page ON narrative_cache(page_id);`,
];

/** Tables every version of the app needs; checked after migrating so a broken upgrade fails loudly, not later. */
const REQUIRED_TABLES = ["users", "sessions", "projects", "project_members", "skills", "skill_instances", "pages", "page_versions", "packages", "imports", "user_source_credentials", "audit_log"];

export class UpgradeError extends Error {}

/** A consistent copy of the live database (safe while the app runs; WAL content is included). */
export function backupDatabase(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

/**
 * Bring the database up to this version of the app. Migrations are numbered and add tables or columns (or
 * rebuild one table, keeping every row), so existing projects and pages are kept. Before the first pending migration a backup copy of the
 * database is written to data/backups. A database created by a newer version is refused rather than touched.
 */
export function migrate(opts: { log?: (m: string) => void; backupDir?: string } = {}) {
  const log = opts.log ?? (() => undefined);
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(all<{ n: number }>("SELECT n FROM _migrations").map((r) => r.n));
  const newest = Math.max(0, ...done);
  if (newest > MIGRATIONS.length) {
    throw new UpgradeError(`The database was created by a newer version of AI BI (schema ${newest}, this build knows ${MIGRATIONS.length}). Upgrade the application instead of downgrading it, or restore a backup made with this version.`);
  }
  const pending = MIGRATIONS.map((sql, i) => ({ n: i + 1, sql })).filter((m) => !done.has(m.n));
  if (pending.length && done.size) {
    const dir = opts.backupDir ?? path.join(path.dirname(config.dbFile), "backups");
    const file = path.join(dir, `aibi-${now().replace(/[:.]/g, "-")}-before-schema-${pending[0].n}.db`);
    backupDatabase(file);
    log(`database backed up to ${file} before applying schema ${pending.map((m) => m.n).join(", ")}`);
    // keep the ten most recent automatic backups
    const old = fs.readdirSync(dir).filter((f) => /^aibi-.*-before-schema-\d+\.db$/.test(f)).sort().reverse().slice(10);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  }
  for (const m of pending) {
    const apply = () => {
      if (typeof m.sql === "function") m.sql();
      else db.exec(m.sql);
      run("INSERT INTO _migrations (n, applied_at) VALUES (?, ?)", m.n, now());
    };
    if (typeof m.sql === "function") {
      // a rebuild drops a table other tables reference: foreign keys off (not changeable inside a transaction),
      // then a full check so a mistake fails the upgrade instead of leaving dangling rows
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        tx(apply);
        const bad = all("PRAGMA foreign_key_check");
        if (bad.length) throw new UpgradeError(`schema ${m.n} left ${bad.length} rows pointing at missing parents; restore the backup and report this`);
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
    } else tx(apply);
    log(`applied schema ${m.n}`);
  }
  const tables = new Set(all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
  const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
  if (missing.length) throw new UpgradeError(`The database is missing tables after migration: ${missing.join(", ")}`);
  const check = get<{ quick_check: string }>("PRAGMA quick_check");
  if (check && check.quick_check !== "ok") throw new UpgradeError(`Database integrity check failed: ${check.quick_check}`);
}

/** Flush the write-ahead log into the main file and close (clean shutdown; the file is then safe to copy). */
export function closeDb() {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* ignore */
  }
  db.close();
}
