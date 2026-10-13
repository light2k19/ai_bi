/**
 * Whole-project packages (.aibi with manifest kind "project").
 *
 * Export: project settings, enabled skills, data sources (configuration without login id, password, token
 * or any other secret), schema annotations, and every page shared with the project plus the exporter's
 * own private pages, each with components, scripts and assets. Vendored modules are shared.
 * Members are not exported (accounts are per server).
 *
 * Import (platform administrators): either a new project, or an overwrite of the project with the same
 * id or slug — overwrite must be confirmed. Overwrite updates settings, enables skills, updates data
 * sources by alias (stored credentials are kept), saves imported pages as new versions of the pages with
 * the same id (history kept) and creates the others. Pages not in the package are left alone.
 */
import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { PageBundle, ProjectPackageManifest, PROJECT_PACKAGE_SPEC, type PackageManifest } from "@aibi/page-spec";
import { config } from "../config";
import { all, get, run, now, json, parse } from "../db";
import { newId, sha256, maskSecrets, sealSecrets, openSecrets, MASK } from "../lib/crypto";
import { badRequest, conflict, notFound, HttpError } from "../lib/errors";
import { getSkill, satisfies } from "../skills/registry";
import type { User } from "./access";
import { audit } from "./audit";
import { getVersion, createPage, saveVersion, type PageRow } from "./pages";
import { schemaOf, setAnnotations, createInstance, secretsOf, credentialsOf, modeFor, credentialFields, withoutCredentials, verifyConfig, closeInstancePools, type Annotations, type InstanceRow, type CredentialMode } from "./sources";
import { enableSkill, installModules, isZip, moduleFilesOf, openZip, pageExtras, writeModules, writePageFiles } from "./packages";
import { SLUG_RE } from "./project-admin";

interface ProjectFile {
  name: string;
  slug: string;
  description: string | null;
  settings: Record<string, unknown>;
}
interface SkillFile {
  id: string;
  version: string;
  settings: Record<string, unknown>;
}
interface SourceFile {
  alias: string;
  name: string;
  description: string | null;
  skill: string;
  config: Record<string, unknown>;
  annotations: Annotations;
  credentialMode?: CredentialMode;
}

/** Exported configuration: no login fields and no secrets (they are asked for, and verified, on import). */
function exportConfig(skillId: string, cfg: Record<string, unknown>) {
  const out = withoutCredentials(skillId, maskSecrets(cfg, secretsOf(skillId)));
  for (const [k, v] of Object.entries(out)) if (v === MASK) delete out[k];
  return out;
}

/** Fields asked for on import: the login fields plus any other top-level secret (e.g. an OAuth client secret). */
export function importFields(skillId: string) {
  const fields = credentialFields(skillId);
  const props = ((getSkill(skillId)?.manifest.configSchema as { properties?: Record<string, { title?: string; description?: string }> } | undefined)?.properties ?? {});
  for (const k of secretsOf(skillId)) if (!k.includes(".") && !fields.some((f) => f.key === k)) fields.push({ key: k, title: props[k]?.title ?? k, description: props[k]?.description, secret: true });
  return fields;
}
interface PageMeta {
  id: string;
  title: string;
  visibility: "private" | "project";
  versionNo: number;
}

/* ───────────────────────── export ───────────────────────── */

export function exportProject(projectId: string, user: User, opts: { vendorModules?: boolean } = {}) {
  const p = get<{ id: string; slug: string; name: string; description: string | null; settings: string }>("SELECT * FROM projects WHERE id = ?", projectId);
  if (!p) throw notFound("Project not found");
  const files: Record<string, Uint8Array> = {};
  const put = (f: string, c: string | Uint8Array) => (files[f] = typeof c === "string" ? strToU8(c) : c);

  const project: ProjectFile = { name: p.name, slug: p.slug, description: p.description, settings: parse(p.settings, {}) };
  put("project.json", JSON.stringify(project, null, 2));

  const skills: SkillFile[] = all<{ skill_id: string; settings: string }>("SELECT skill_id, settings FROM project_skills WHERE project_id = ? AND enabled = 1 ORDER BY skill_id", projectId)
    .map((r) => ({ id: r.skill_id, version: getSkill(r.skill_id)?.manifest.version ?? "0.0.0", settings: parse(r.settings, {}) }));
  put("skills.json", JSON.stringify(skills, null, 2));

  const sources: SourceFile[] = all<InstanceRow>("SELECT * FROM skill_instances WHERE project_id = ? ORDER BY alias", projectId).map((i) => ({
    alias: i.alias,
    name: i.name,
    description: i.description,
    skill: i.skill_id,
    // credentials never leave the server: login fields and secrets are removed
    config: exportConfig(i.skill_id, parse(i.config, {})),
    annotations: schemaOf(i.id).annotations,
    credentialMode: i.credential_mode ?? "shared",
  }));
  put("sources.json", JSON.stringify(sources, null, 2));

  const pages = all<PageRow & { visibility: string; owner_id: string | null }>(
    "SELECT * FROM pages WHERE project_id = ? AND deleted = 0 AND (visibility = 'project' OR owner_id = ?) ORDER BY title",
    projectId,
    user.id,
  );
  const seen = new Map<string, PackageManifest["requires"]["modules"][number]>();
  const required = new Map<string, string>(skills.map((s) => [s.id, `^${s.version}`]));
  const pageEntries: ProjectPackageManifest["pages"] = [];
  for (const row of pages) {
    const v = getVersion(row.id, row.current_version);
    const bundle = PageBundle.parse(v.bundle);
    const dir = `pages/${row.id}/`;
    writePageFiles(put, bundle, dir);
    const meta: PageMeta = { id: row.id, title: bundle.page.title, visibility: row.visibility === "private" ? "private" : "project", versionNo: v.versionNo };
    put(`${dir}meta.json`, JSON.stringify(meta, null, 2));
    writeModules(put, bundle.page.modules, opts.vendorModules ?? true, seen);
    for (const [id, range] of Object.entries((v.requires as { skills?: Record<string, string> }).skills ?? {})) if (!required.has(id)) required.set(id, range);
    pageEntries.push({ id: row.id, title: bundle.page.title, versionNo: v.versionNo, dir: `pages/${row.id}` });
  }

  const manifest: ProjectPackageManifest = {
    spec: PROJECT_PACKAGE_SPEC,
    kind: "project",
    name: p.slug,
    version: now().slice(0, 10).replace(/-/g, "."),
    title: p.name,
    description: p.description ?? undefined,
    exportedAt: now(),
    exportedBy: { name: user.displayName ?? undefined, email: user.email ?? undefined },
    app: { name: "ai-bi", version: config.appVersion, minVersion: "0.1.0" },
    project: { id: p.id, slug: p.slug, name: p.name, description: p.description },
    pages: pageEntries,
    sources: sources.map((s) => ({ alias: s.alias, name: s.name, skill: s.skill })),
    requires: { skills: [...required].map(([id, range]) => ({ id, range })), modules: [...seen.values()] },
    checksums: "CHECKSUMS.json",
  };
  put("manifest.json", JSON.stringify(manifest, null, 2));
  put(
    "README.md",
    [
      `# ${p.name} (project package)`,
      "",
      p.description ?? "",
      "",
      `Exported ${manifest.exportedAt} from AI BI ${config.appVersion}: ${pageEntries.length} pages, ${sources.length} data sources, ${skills.length} skills.`,
      "",
      "Import it from the Projects page (Import project). Credentials are not included: enter them for each data source after importing.",
    ].join("\n"),
  );
  const checksums: Record<string, string> = {};
  for (const [f, c] of Object.entries(files)) checksums[f] = sha256(Buffer.from(c));
  put("CHECKSUMS.json", JSON.stringify(checksums, null, 2));
  const zip = zipSync(files, { level: 6 });
  audit(projectId, user.id, "project.export", projectId, { pages: pageEntries.length, sources: sources.length });
  return { filename: `${p.slug}-project-${manifest.version}.aibi`, buffer: Buffer.from(zip), manifest };
}

/* ───────────────────────── import ───────────────────────── */

export interface ProjectImportReport {
  importId: string;
  manifest: Pick<ProjectPackageManifest, "name" | "version" | "title" | "exportedAt" | "exportedBy">;
  project: { id: string; name: string; slug: string; description: string | null };
  pages: { id: string; title: string; widgets: number; datasets: number; action: "create" | "update" }[];
  /** fields: what to ask for (login id, password…); canKeep: an overwrite may leave them empty to keep the stored ones */
  sources: { alias: string; name: string; skill: string; action: "create" | "update"; credentialMode: CredentialMode; fields: { key: string; title: string; description?: string; secret: boolean }[]; canKeep: boolean }[];
  skills: { id: string; range: string; status: "ok" | "missing" | "version" | "unapproved"; installed?: string }[];
  modules: number;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
  /** existing project with the same id or slug (also archived ones) */
  conflict: { id: string; slug: string; name: string; archived: boolean; matchedBy: "id" | "slug"; pages: number; pagesKept: number } | null;
  suggestedSlug: string;
  modes: ("new" | "overwrite")[];
}

interface Unpacked {
  manifest: ProjectPackageManifest;
  project: ProjectFile;
  skills: SkillFile[];
  sources: SourceFile[];
  pages: { meta: PageMeta; bundle: PageBundle }[];
  moduleFiles: Record<string, string>;
}

function readProjectPackage(buf: Buffer, filename: string): Unpacked {
  if (!isZip(buf)) throw badRequest(`${filename} is not a project package (.aibi)`);
  const { entries, text } = openZip(buf, filename);
  const mtext = text("manifest.json");
  if (!mtext) throw badRequest("package has no manifest.json");
  const raw = JSON.parse(mtext) as { kind?: string };
  if (raw.kind !== "project") throw badRequest(`${filename} is a page package. Import it inside its project (Import page), not as a project.`);
  const m = ProjectPackageManifest.safeParse(raw);
  if (!m.success) throw badRequest(`manifest.json is invalid: ${m.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const read = <T>(f: string, fallback: T): T => {
    const t = text(f);
    return t ? (JSON.parse(t) as T) : fallback;
  };
  const project = read<ProjectFile | null>("project.json", null);
  if (!project) throw badRequest("package has no project.json");
  const pages = m.data.pages.map((p) => {
    const prefix = `${p.dir}/`;
    const ptext = text(`${prefix}page.json`);
    if (!ptext) throw badRequest(`package is missing ${prefix}page.json`);
    const parsed = PageBundle.safeParse({ page: JSON.parse(ptext), ...pageExtras(entries, prefix) });
    if (!parsed.success) throw badRequest(`${prefix}page.json is invalid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const meta = read<PageMeta>(`${prefix}meta.json`, { id: p.id, title: p.title, visibility: "project", versionNo: p.versionNo });
    return { meta, bundle: parsed.data };
  });
  return { manifest: m.data, project, skills: read<SkillFile[]>("skills.json", []), sources: read<SourceFile[]>("sources.json", []), pages, moduleFiles: moduleFilesOf(entries) };
}

function findTarget(pkgProject: { id: string; slug: string }) {
  type Row = { id: string; slug: string; name: string; archived: number };
  const byId = get<Row>("SELECT id, slug, name, archived FROM projects WHERE id = ?", pkgProject.id);
  if (byId) return { row: byId, matchedBy: "id" as const };
  const bySlug = get<Row>("SELECT id, slug, name, archived FROM projects WHERE slug = ?", pkgProject.slug);
  return bySlug ? { row: bySlug, matchedBy: "slug" as const } : null;
}

function freeSlug(base: string) {
  const root = (base.match(/^[a-z0-9][a-z0-9-]*/)?.[0] ?? "project").slice(0, 36);
  if (!get("SELECT 1 FROM projects WHERE slug = ?", root) && SLUG_RE.test(root)) return root;
  for (let n = 2; ; n++) if (!get("SELECT 1 FROM projects WHERE slug = ?", `${root}-${n}`)) return `${root}-${n}`;
}

const importDir = () => path.join(config.dataDir, "imports");

export function analyzeProjectImport(user: User, buf: Buffer, filename: string): ProjectImportReport {
  const up = readProjectPackage(buf, filename);
  const errors: ProjectImportReport["errors"] = [];
  const warnings: ProjectImportReport["warnings"] = [];

  const skills: ProjectImportReport["skills"] = up.manifest.requires.skills.map((r) => {
    const s = getSkill(r.id);
    if (!s) return { ...r, status: "missing" as const };
    if (!s.approved) return { ...r, status: "unapproved" as const, installed: s.manifest.version };
    return { ...r, status: satisfies(s.manifest.version, r.range) ? ("ok" as const) : ("version" as const), installed: s.manifest.version };
  });
  for (const s of skills) {
    if (s.status === "missing") errors.push({ path: `skills.${s.id}`, message: `skill '${s.id}' is not installed on this server; upload it first` });
    if (s.status === "unapproved") errors.push({ path: `skills.${s.id}`, message: `skill '${s.id}' is installed but waiting for approval` });
    if (s.status === "version") warnings.push({ path: `skills.${s.id}`, message: `the project was built with ${s.id} ${s.range}; this server has ${s.installed}` });
  }

  const target = findTarget(up.manifest.project);
  const targetRows = new Map(target ? all<InstanceRow>("SELECT * FROM skill_instances WHERE project_id = ?", target.row.id).map((r) => [r.alias, r]) : []);
  const targetSources = new Set(targetRows.keys());
  const targetPages = new Set(target ? all<{ id: string }>("SELECT id FROM pages WHERE project_id = ? AND deleted = 0", target.row.id).map((r) => r.id) : []);
  const sources = up.sources.map((s) => ({
    alias: s.alias,
    name: s.name,
    skill: s.skill,
    action: targetSources.has(s.alias) ? ("update" as const) : ("create" as const),
    credentialMode: modeFor(s.skill),
    fields: importFields(s.skill),
    canKeep: Object.keys(storedLogin(targetRows.get(s.alias), user.id)).length > 0,
  }));
  const pages = up.pages.map((p) => ({ id: p.meta.id, title: p.bundle.page.title, widgets: p.bundle.page.widgets.length, datasets: p.bundle.page.datasets.length, action: targetPages.has(p.meta.id) ? ("update" as const) : ("create" as const) }));

  const importId = newId("pim");
  const conflictInfo = target
    ? { id: target.row.id, slug: target.row.slug, name: target.row.name, archived: target.row.archived === 1, matchedBy: target.matchedBy, pages: targetPages.size, pagesKept: [...targetPages].filter((id) => !up.pages.some((p) => p.meta.id === id)).length }
    : null;
  const report: ProjectImportReport = {
    importId,
    manifest: { name: up.manifest.name, version: up.manifest.version, title: up.manifest.title, exportedAt: up.manifest.exportedAt, exportedBy: up.manifest.exportedBy },
    project: { id: up.manifest.project.id, name: up.project.name, slug: up.project.slug, description: up.project.description },
    pages,
    sources,
    skills,
    modules: up.manifest.requires.modules.length,
    errors,
    warnings,
    conflict: conflictInfo,
    suggestedSlug: freeSlug(up.project.slug),
    modes: conflictInfo ? ["overwrite", "new"] : ["new"],
  };
  fs.mkdirSync(importDir(), { recursive: true });
  fs.writeFileSync(path.join(importDir(), `${importId}.bin`), buf);
  fs.writeFileSync(path.join(importDir(), `${importId}.json`), JSON.stringify({ userId: user.id, status: "analyzed", report }));
  return report;
}

/** The login values currently stored for an instance (shared config, or the user's own in per-user mode). */
function storedLogin(cur: InstanceRow | undefined, userId: string): Record<string, unknown> {
  if (!cur) return {};
  const keys = importFields(cur.skill_id).map((f) => f.key);
  const shared = openSecrets(parse(cur.config, {}), secretsOf(cur.skill_id));
  const mine = cur.credential_mode === "user" ? get<{ config: string }>("SELECT config FROM user_source_credentials WHERE instance_id = ? AND user_id = ?", cur.id, userId) : undefined;
  const src = { ...shared, ...(mine ? openSecrets(parse(mine.config, {}), secretsOf(cur.skill_id)) : {}) };
  return Object.fromEntries(keys.filter((k) => src[k] !== undefined && src[k] !== null && src[k] !== "").map((k) => [k, src[k]]));
}

function loadImport(importId: string, user: User) {
  if (!/^pim_[A-Za-z0-9_-]+$/.test(importId)) throw notFound("Import not found");
  const f = path.join(importDir(), `${importId}.json`);
  if (!fs.existsSync(f)) throw notFound("Import not found");
  const rec = JSON.parse(fs.readFileSync(f, "utf8")) as { userId: string; status: string; report: ProjectImportReport };
  if (rec.userId !== user.id) throw notFound("Import not found");
  return { ...rec, file: f, bin: path.join(importDir(), `${importId}.bin`) };
}

export function getProjectImport(importId: string, user: User) {
  return loadImport(importId, user).report;
}

export async function commitProjectImport(
  user: User,
  importId: string,
  opts: { mode: "new" | "overwrite"; slug?: string; name?: string; overwrite?: boolean; credentials?: Record<string, Record<string, unknown>> },
) {
  const rec = loadImport(importId, user);
  if (rec.status === "committed") throw badRequest("This import was already completed");
  const rep = rec.report;
  if (rep.errors.length) throw new HttpError(422, "The package has errors; fix them before importing", { errors: rep.errors });
  const up = readProjectPackage(fs.readFileSync(rec.bin), "upload");
  if (opts.mode === "overwrite" && !opts.overwrite && findTarget(up.manifest.project)) {
    const t = findTarget(up.manifest.project)!;
    throw new HttpError(409, `Project “${t.row.name}” (${t.row.slug}) already exists. Confirm to overwrite it: settings and data sources are updated, imported pages become new versions, and its other pages are kept.`, { code: "confirm_overwrite", conflict: rep.conflict });
  }
  if (opts.mode === "new") {
    const want = opts.slug ?? rep.suggestedSlug;
    if (!SLUG_RE.test(want)) throw badRequest("Slug: 2–41 lower-case letters, digits and dashes, starting with a letter or digit");
    if (get("SELECT 1 FROM projects WHERE slug = ?", want)) throw conflict(`The slug '${want}' is taken; choose another one or overwrite the existing project`);
  }

  // verify every data source with the login entered for it before anything is saved
  const overwriteTarget = opts.mode === "overwrite" ? findTarget(up.manifest.project) : null;
  const plans: { s: SourceFile; mode: CredentialMode; login: Record<string, unknown>; message: string }[] = [];
  const failures: { alias: string; message: string }[] = [];
  for (const s of up.sources) {
    const keys = importFields(s.skill).map((f) => f.key);
    const given = Object.fromEntries(Object.entries(opts.credentials?.[s.alias] ?? {}).filter(([k, v]) => keys.includes(k) && v !== undefined && v !== null && v !== "" && v !== MASK));
    const cur = overwriteTarget ? get<InstanceRow>("SELECT * FROM skill_instances WHERE project_id = ? AND alias = ?", overwriteTarget.row.id, s.alias) : undefined;
    const login = { ...storedLogin(cur, user.id), ...given };
    const test = await verifyConfig(s.skill, s.alias, { ...s.config, ...login });
    if (!test.ok) failures.push({ alias: s.alias, message: test.message });
    plans.push({ s, mode: modeFor(s.skill), login, message: test.message });
  }
  if (failures.length) {
    throw new HttpError(422, `Could not connect to ${failures.map((f) => `'${f.alias}'`).join(", ")} with the login details given. Nothing was imported.`, { code: "credentials_invalid", sources: failures });
  }

  let projectId: string;
  let slug: string;
  if (opts.mode === "overwrite") {
    const target = findTarget(up.manifest.project);
    if (!target) throw badRequest("There is no existing project to overwrite; import it as a new project");
    projectId = target.row.id;
    slug = target.row.slug;
    run("UPDATE projects SET name = ?, description = ?, settings = ?, archived = 0 WHERE id = ?", opts.name?.trim() || up.project.name, up.project.description ?? null, json(up.project.settings ?? {}), projectId);
    if (!get("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?", projectId, user.id)) run("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?,?,?,?)", projectId, user.id, "admin", now());
  } else {
    slug = opts.slug ?? rep.suggestedSlug;
    // keep the original id when it is free (e.g. moving a project to another server)
    projectId = get("SELECT 1 FROM projects WHERE id = ?", up.manifest.project.id) ? newId("prj") : up.manifest.project.id;
    run("INSERT INTO projects (id, slug, name, description, settings, created_by, created_at) VALUES (?,?,?,?,?,?,?)", projectId, slug, opts.name?.trim() || up.project.name, up.project.description ?? null, json(up.project.settings ?? {}), user.id, now());
    run("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?,?,?,?)", projectId, user.id, "admin", now());
  }

  // skills (enabled with their project settings) and the data source skills the sources need
  for (const s of up.skills) {
    enableSkill(projectId, s.id);
    if (s.settings && Object.keys(s.settings).length) run("UPDATE project_skills SET settings = ? WHERE project_id = ? AND skill_id = ?", json(s.settings), projectId, s.id);
  }
  for (const s of up.sources) enableSkill(projectId, s.skill);

  // data sources by alias, with the verified login: shared config, or the importer's own login in per-user mode
  const counts = { sourcesCreated: 0, sourcesUpdated: 0, pagesCreated: 0, pagesUpdated: 0 };
  for (const { s: src, mode, login, message } of plans) {
    const userKeys = credentialsOf(src.skill);
    const sharedPart = mode === "user" ? Object.fromEntries(Object.entries(login).filter(([k]) => !userKeys.includes(k))) : login;
    const userPart = mode === "user" ? Object.fromEntries(Object.entries(login).filter(([k]) => userKeys.includes(k))) : {};
    const config = { ...src.config, ...sharedPart };
    const cur = get<InstanceRow>("SELECT * FROM skill_instances WHERE project_id = ? AND alias = ?", projectId, src.alias);
    let instanceId: string;
    if (cur) {
      const cfg = sealSecrets(mode === "user" ? withoutCredentials(cur.skill_id, config) : config, secretsOf(cur.skill_id), mode === "user" ? withoutCredentials(cur.skill_id, parse(cur.config, {})) : parse(cur.config, {}));
      run("UPDATE skill_instances SET name = ?, description = ?, config = ?, credential_mode = ?, status = 'ok', status_message = ?, updated_at = ? WHERE id = ?", src.name, src.description ?? null, json(cfg), mode, message, now(), cur.id);
      await closeInstancePools(cur);
      instanceId = cur.id;
      counts.sourcesUpdated++;
    } else {
      instanceId = createInstance(projectId, { skill: src.skill, name: src.name, alias: src.alias, description: src.description ?? undefined, config, credentialMode: mode }).id;
      run("UPDATE skill_instances SET status = 'ok', status_message = ? WHERE id = ?", message, instanceId);
      counts.sourcesCreated++;
    }
    if (mode === "user" && Object.keys(userPart).length) {
      run(
        "INSERT INTO user_source_credentials (instance_id, user_id, config, status, status_message, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(instance_id, user_id) DO UPDATE SET config = excluded.config, status = excluded.status, status_message = excluded.status_message, updated_at = excluded.updated_at",
        instanceId, user.id, json(sealSecrets(userPart, secretsOf(src.skill))), "ok", message, now(),
      );
    }
    if (src.annotations && Object.keys(src.annotations).length) setAnnotations(instanceId, src.annotations);
  }

  // pages: same id in this project → new version; otherwise a new page (keeping the id when it is free)
  const message = `Imported from project package ${up.manifest.name}@${up.manifest.version}`;
  for (const p of up.pages) {
    installModules(projectId, user, p.bundle.page.modules, up.manifest.requires.modules, up.moduleFiles);
    const existing = get<PageRow>("SELECT * FROM pages WHERE id = ? AND project_id = ? AND deleted = 0", p.meta.id, projectId);
    if (existing) {
      await saveVersion(projectId, existing, user, p.bundle, { message, source: "import", force: true });
      counts.pagesUpdated++;
    } else {
      await createPage(projectId, user, p.bundle, { message, source: "import", keepId: true, visibility: p.meta.visibility });
      counts.pagesCreated++;
    }
  }

  fs.writeFileSync(rec.file, JSON.stringify({ userId: user.id, status: "committed", report: rep }));
  audit(projectId, user.id, "project.import", projectId, { mode: opts.mode, package: `${up.manifest.name}@${up.manifest.version}`, ...counts });
  return { projectId, slug, mode: opts.mode, ...counts };
}
