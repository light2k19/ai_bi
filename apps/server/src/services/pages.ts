import { validatePage, PageBundle, type ValidationResult, type PageBundleInput } from "@aibi/page-spec";
import { all, get, run, now, json, parse, tx } from "../db";
import { newId } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound, HttpError } from "../lib/errors";
import { catalogueFor, enabledSkills } from "../skills/registry";
import { roleAtLeast, type Role, type User } from "./access";
import { audit } from "./audit";
import { ensureModulesResolved } from "./modules";
import { connectionOverrides, overrideMessage } from "./sources";
import { diff } from "../lib/jsondiff";
import { forgetCommentary } from "../ai/ask";

export interface PageRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  tags: string;
  visibility: "private" | "project";
  owner_id: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
  deleted: number;
}

/**
 * A page is available only while every data source its current version reads from exists, is enabled, and
 * belongs to a skill that is enabled in the project. Disabling a data source therefore disables its pages.
 */
export function pageAvailability(p: PageRow, role: Role = "admin"): { available: boolean; disabledSources: string[]; missingSources: string[]; versionsDisabled: boolean } {
  const v = get<{ requires: string; enabled: number }>("SELECT requires, enabled FROM page_versions WHERE page_id = ? AND version_no = ?", p.id, p.current_version);
  // every version switched off: the page is off for everyone but admins, who still see all versions
  const versionsDisabled = !v || v.enabled === 0;
  const aliases = Object.keys((parse<{ sources?: Record<string, unknown> }>(v?.requires, {}).sources ?? {}));
  const enabled = new Set(aliases.length ? enabledSkills(p.project_id).map((s) => s.manifest.id) : []);
  const disabledSources: string[] = [];
  const missingSources: string[] = [];
  for (const alias of aliases) {
    const inst = get<{ status: string; skill_id: string }>("SELECT status, skill_id FROM skill_instances WHERE project_id = ? AND alias = ?", p.project_id, alias);
    if (!inst) missingSources.push(alias);
    else if (inst.status === "disabled" || !enabled.has(inst.skill_id)) disabledSources.push(alias);
  }
  return { available: !disabledSources.length && !missingSources.length && (!versionsDisabled || seesAllVersions(role)), disabledSources, missingSources, versionsDisabled };
}

export function pageMeta(p: PageRow, role: Role = "admin") {
  const owner = p.owner_id ? get<{ login: string; email: string | null; display_name: string | null }>("SELECT login, email, display_name FROM users WHERE id = ?", p.owner_id) : undefined;
  return {
    ...pageAvailability(p, role),
    id: p.id,
    title: p.title,
    description: p.description,
    tags: parse<string[]>(p.tags, []),
    visibility: p.visibility,
    owner: owner ? { id: p.owner_id, login: owner.login, email: owner.email, name: owner.display_name } : null,
    currentVersion: p.current_version,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export function canView(p: PageRow, user: User, role: Role) {
  return p.visibility === "project" || p.owner_id === user.id || roleAtLeast(role, "admin");
}
export function canEdit(p: PageRow, user: User, role: Role) {
  if (!roleAtLeast(role, "builder")) return false;
  return p.owner_id === user.id || roleAtLeast(role, "admin") || p.visibility === "project";
}

export function listPages(projectId: string, user: User, role: Role) {
  return all<PageRow>("SELECT * FROM pages WHERE project_id = ? AND deleted = 0 ORDER BY updated_at DESC", projectId)
    .filter((p) => canView(p, user, role))
    .map((p) => pageMeta(p, role));
}

export function loadPage(projectId: string, pageId: string, user: User, role: Role, need: "view" | "edit" = "view"): PageRow {
  const p = get<PageRow>("SELECT * FROM pages WHERE id = ? AND project_id = ? AND deleted = 0", pageId, projectId);
  if (!p || !canView(p, user, role)) throw notFound("Page not found");
  if (need === "edit" && !canEdit(p, user, role)) throw forbidden("You cannot edit this page");
  return p;
}

type VersionRow = { version_no: number; bundle: string; requires: string; message: string | null; source: string; created_by: string | null; created_at: string; ai_session_id: string | null; enabled: number };

/** Only project admins see versions that were switched off; everyone else gets "not found" for them. */
export const seesAllVersions = (role: Role) => roleAtLeast(role, "admin");

export function getVersion(pageId: string, versionNo?: number, opts: { includeDisabled?: boolean } = {}) {
  const row = versionNo
    ? get<VersionRow>("SELECT * FROM page_versions WHERE page_id = ? AND version_no = ?", pageId, versionNo)
    : get<VersionRow>("SELECT * FROM page_versions WHERE page_id = ? ORDER BY version_no DESC LIMIT 1", pageId);
  if (!row || (opts.includeDisabled === false && row.enabled === 0)) throw notFound("Version not found");
  return {
    versionNo: row.version_no,
    enabled: row.enabled !== 0,
    bundle: parse<PageBundle>(row.bundle, null as never),
    requires: parse(row.requires, {}),
    message: row.message,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
    aiSessionId: row.ai_session_id,
  };
}

export function listVersions(pageId: string, includeDisabled = true) {
  return all<{ version_no: number; message: string | null; source: string; created_by: string | null; created_at: string; email: string | null; enabled: number }>(
    `SELECT v.version_no, v.message, v.source, v.created_by, v.created_at, v.enabled, u.email FROM page_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.page_id = ?${includeDisabled ? "" : " AND v.enabled = 1"} ORDER BY v.version_no DESC`,
    pageId,
  ).map((v) => ({ versionNo: v.version_no, enabled: v.enabled !== 0, message: v.message, source: v.source, createdBy: v.email, createdAt: v.created_at }));
}

/**
 * Switch a version off (admins keep seeing it; others do not) or on. Switching the default version off hands
 * the default to the newest enabled version; when none is left the page is off for everyone but admins.
 * Switching a version on while the page had no enabled version makes it the default.
 */
export function setVersionEnabled(projectId: string, page: PageRow, user: User, versionNo: number, enabled: boolean) {
  if (!get("SELECT 1 FROM page_versions WHERE page_id = ? AND version_no = ?", page.id, versionNo)) throw notFound(`Version ${versionNo} not found`);
  let current = page.current_version;
  tx(() => {
    run("UPDATE page_versions SET enabled = ? WHERE page_id = ? AND version_no = ?", enabled ? 1 : 0, page.id, versionNo);
    const currentEnabled = get<{ enabled: number }>("SELECT enabled FROM page_versions WHERE page_id = ? AND version_no = ?", page.id, page.current_version)?.enabled === 1;
    if (!currentEnabled) {
      const next = get<{ n: number | null }>("SELECT MAX(version_no) AS n FROM page_versions WHERE page_id = ? AND enabled = 1", page.id)!.n;
      if (next) current = next;
    }
    if (current !== page.current_version) {
      const b = getVersion(page.id, current).bundle;
      run("UPDATE pages SET current_version = ?, title = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?", current, b.page.title, b.page.description ?? null, json(b.page.tags ?? []), now(), page.id);
      forgetCommentary(page.id);
    }
  });
  const versionsDisabled = !get("SELECT 1 FROM page_versions WHERE page_id = ? AND enabled = 1", page.id);
  audit(projectId, user.id, enabled ? "page.version.enable" : "page.version.disable", page.id, { versionNo, currentVersion: current, versionsDisabled });
  return { ok: true, currentVersion: current, versionsDisabled };
}

/** Make an existing, enabled version the one everybody opens, without creating a new version (unlike restore). */
export function setDefaultVersion(projectId: string, page: PageRow, user: User, versionNo: number) {
  const v = getVersion(page.id, versionNo);
  if (!v.enabled) throw badRequest(`Version ${versionNo} is disabled; enable it first`);
  run("UPDATE pages SET current_version = ?, title = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?", versionNo, v.bundle.page.title, v.bundle.page.description ?? null, json(v.bundle.page.tags ?? []), now(), page.id);
  forgetCommentary(page.id);
  audit(projectId, user.id, "page.version.default", page.id, { versionNo, previous: page.current_version });
  return { ok: true, currentVersion: versionNo };
}

/** Validate a bundle for saving: strict catalogue, resolved modules. Returns the normalised bundle. */
export async function validateForSave(projectId: string, input: unknown, userId: string): Promise<ValidationResult & { bundle: PageBundle }> {
  const parsed = PageBundle.safeParse(input);
  if (!parsed.success) throw new HttpError(422, "Page bundle is invalid", { errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })), warnings: [] });
  // resolve modules (fetch, vendor, hash) before strict validation
  parsed.data.page.modules = await ensureModulesResolved(projectId, parsed.data.page.modules, userId);
  const res = validatePage(parsed.data, { catalogue: catalogueFor(projectId), requireModuleHashes: true });
  // every page connects through the project's data sources as configured: no connection or login settings in a page
  parsed.data.page.datasets.forEach((d, i) => {
    if (!d.source || !d.request) return;
    const inst = get<{ skill_id: string }>("SELECT skill_id FROM skill_instances WHERE project_id = ? AND alias = ?", projectId, d.source);
    const bad = inst ? connectionOverrides(inst.skill_id, d.request) : [];
    if (bad.length) {
      res.errors.push({ path: `datasets[${i}].request`, message: overrideMessage(d.source, bad) });
      res.ok = false;
    }
  });
  if (!res.ok || !res.bundle) throw new HttpError(422, `Page has ${res.errors.length} error(s)`, { errors: res.errors, warnings: res.warnings });
  return res as ValidationResult & { bundle: PageBundle };
}

export async function createPage(
  projectId: string,
  user: User,
  input: PageBundleInput,
  opts: { message?: string; source: "ai" | "manual" | "import" | "template"; aiSessionId?: string; keepId?: boolean; visibility?: "private" | "project" } = { source: "manual" },
) {
  const draft = PageBundle.parse(input);
  const wantId = opts.keepId && draft.page.id && !get("SELECT 1 FROM pages WHERE id = ?", draft.page.id) ? draft.page.id : newId("pg");
  draft.page.id = wantId;
  const v = await validateForSave(projectId, draft, user.id);
  const t = now();
  tx(() => {
    run(
      "INSERT INTO pages (id, project_id, title, description, tags, visibility, owner_id, current_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      wantId, projectId, v.bundle.page.title, v.bundle.page.description ?? null, json(v.bundle.page.tags ?? []), opts.visibility ?? "project", user.id, 1, t, t,
    );
    run(
      "INSERT INTO page_versions (page_id, version_no, bundle, requires, message, source, created_by, created_at, ai_session_id) VALUES (?,?,?,?,?,?,?,?,?)",
      wantId, 1, json(v.bundle), json(v.requires), opts.message ?? "Created", opts.source, user.id, t, opts.aiSessionId ?? null,
    );
  });
  audit(projectId, user.id, "page.create", wantId, { source: opts.source, title: v.bundle.page.title });
  return { id: wantId, versionNo: 1, warnings: v.warnings };
}

export async function saveVersion(
  projectId: string,
  page: PageRow,
  user: User,
  input: unknown,
  opts: { message?: string; source: "ai" | "manual" | "import" | "restore"; baseVersion?: number; aiSessionId?: string; force?: boolean },
) {
  if (opts.baseVersion !== undefined && opts.baseVersion < page.current_version && !opts.force) {
    const cur = getVersion(page.id, page.current_version);
    throw conflict(`The page changed since version ${opts.baseVersion} (now ${page.current_version}). Review the differences and save again with force.`, {
      currentVersion: page.current_version,
      changes: diff(PageBundle.parse(input).page, cur.bundle.page).slice(0, 200),
    });
  }
  const b = PageBundle.parse(input);
  b.page.id = page.id;
  const v = await validateForSave(projectId, b, user.id);
  // numbering continues after the newest version, which need not be the default
  const next = (get<{ n: number | null }>("SELECT MAX(version_no) AS n FROM page_versions WHERE page_id = ?", page.id)!.n ?? 0) + 1;
  const t = now();
  tx(() => {
    run(
      "INSERT INTO page_versions (page_id, version_no, bundle, requires, message, source, created_by, created_at, ai_session_id) VALUES (?,?,?,?,?,?,?,?,?)",
      page.id, next, json(v.bundle), json(v.requires), opts.message ?? null, opts.source, user.id, t, opts.aiSessionId ?? null,
    );
    run("UPDATE pages SET current_version = ?, title = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?", next, v.bundle.page.title, v.bundle.page.description ?? null, json(v.bundle.page.tags ?? []), t, page.id);
    forgetCommentary(page.id);
  });
  audit(projectId, user.id, "page.version", page.id, { versionNo: next, source: opts.source });
  return { id: page.id, versionNo: next, warnings: v.warnings };
}

export function updateMeta(projectId: string, page: PageRow, user: User, patch: { visibility?: "private" | "project"; ownerId?: string }) {
  if (patch.visibility && !["private", "project"].includes(patch.visibility)) throw badRequest("visibility must be private or project");
  if (patch.ownerId && !get("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?", projectId, patch.ownerId)) throw badRequest("new owner must be a project member");
  run("UPDATE pages SET visibility = ?, owner_id = ?, updated_at = ? WHERE id = ?", patch.visibility ?? page.visibility, patch.ownerId ?? page.owner_id, now(), page.id);
  audit(projectId, user.id, "page.meta", page.id, patch);
}

export function deletePage(projectId: string, page: PageRow, user: User) {
  run("UPDATE pages SET deleted = 1, updated_at = ? WHERE id = ?", now(), page.id);
  forgetCommentary(page.id);
  audit(projectId, user.id, "page.delete", page.id);
}

/**
 * Delete one version of a page (project admins). Deleting the default version makes the newest enabled
 * remaining version the default (title and description follow it). Deleting the only version deletes the
 * page itself: the caller confirms that first (`confirmPageDelete`).
 */
export function deleteVersion(projectId: string, page: PageRow, user: User, versionNo: number, opts: { confirmPageDelete?: boolean } = {}) {
  const exists = get("SELECT 1 FROM page_versions WHERE page_id = ? AND version_no = ?", page.id, versionNo);
  if (!exists) throw notFound(`Version ${versionNo} not found`);
  const count = get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?", page.id)!.n;
  if (count <= 1) {
    if (!opts.confirmPageDelete) throw conflict(`Version ${versionNo} is the only version of “${page.title}”: deleting it deletes the page`, { code: "confirm_page_delete" });
    deletePage(projectId, page, user);
    return { ok: true, currentVersion: 0, pageDeleted: true };
  }
  let current = page.current_version;
  tx(() => {
    run("DELETE FROM page_versions WHERE page_id = ? AND version_no = ?", page.id, versionNo);
    if (versionNo === page.current_version) {
      // the newest enabled version takes over; when none is left, the newest one is switched back on
      current = get<{ n: number | null }>("SELECT MAX(version_no) AS n FROM page_versions WHERE page_id = ? AND enabled = 1", page.id)!.n ?? get<{ n: number }>("SELECT MAX(version_no) AS n FROM page_versions WHERE page_id = ?", page.id)!.n;
      run("UPDATE page_versions SET enabled = 1 WHERE page_id = ? AND version_no = ?", page.id, current);
      const b = PageBundle.parse(parse(get<{ bundle: string }>("SELECT bundle FROM page_versions WHERE page_id = ? AND version_no = ?", page.id, current)!.bundle, {}));
      run("UPDATE pages SET current_version = ?, title = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?", current, b.page.title, b.page.description ?? null, json(b.page.tags ?? []), now(), page.id);
      forgetCommentary(page.id);
    }
  });
  audit(projectId, user.id, "page.version.delete", page.id, { versionNo, currentVersion: current });
  return { ok: true, currentVersion: current, pageDeleted: false };
}

export function versionDiff(pageId: string, from: number, to: number) {
  const a = getVersion(pageId, from).bundle;
  const b = getVersion(pageId, to).bundle;
  return diff(a, b);
}
