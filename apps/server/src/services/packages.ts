import fs from "node:fs";
import path from "node:path";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import {
  PageBundle,
  PageDefinition,
  PackageManifest,
  PACKAGE_SPEC,
  type PackageProjectRef,
  validatePage,
  defaultFilterValues,
  type ModuleRef,
  type PageBundleInput,
} from "@aibi/page-spec";
import { checkReadOnly, tokenize, significant, unquote, type Dialect } from "@aibi/sql-guard";
import { config } from "../config";
import { all, get, run, now, json, parse } from "../db";
import { newId, sha256 } from "../lib/crypto";
import { badRequest, notFound, HttpError } from "../lib/errors";
import { catalogueFor, enabledSkills, getSkill, satisfies } from "../skills/registry";
import { memberRole, type User } from "./access";
import { audit } from "./audit";
import { getVersion, createPage, saveVersion, loadPage, canEdit, type PageRow } from "./pages";
import { moduleFiles, storeVendored, findModule, attachToProject } from "./modules";
import { listInstances, schemaOf, ensureSchema } from "./sources";
import { runQuery } from "./gateway";

const MAX_ZIP_FILES = 600;
const MAX_UNZIPPED = 60_000_000;

/* ───────────────────────── export ───────────────────────── */

/** Columns of the referenced tables that appear in the SQL text (for coverage checks on import). */
function sqlColumnUse(sql: string, dialect: Dialect, tableColumns: Map<string, string[]>): Record<string, string[]> {
  const words = new Set<string>();
  try {
    for (const t of significant(tokenize(sql, dialect))) if (t.kind === "word" || t.kind === "quoted") words.add(unquote(t.text).toLowerCase());
  } catch {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [table, cols] of tableColumns) {
    const used = cols.filter((c) => words.has(c.toLowerCase()));
    if (used.length) out[table] = used;
  }
  return out;
}

/** The project a package belongs to (stamped into page packages). */
export function projectRef(projectId: string): PackageProjectRef {
  const p = get<{ id: string; slug: string; name: string }>("SELECT id, slug, name FROM projects WHERE id = ?", projectId);
  if (!p) throw notFound("Project not found");
  return { id: p.id, slug: p.slug, name: p.name };
}

type Put = (p: string, content: string | Uint8Array) => void;

/** page.json, components/, scripts/ and assets/ of one bundle under `prefix` ("" or "pages/<id>/"). */
export function writePageFiles(put: Put, bundle: PageBundle, prefix = "") {
  put(`${prefix}page.json`, JSON.stringify(bundle.page, null, 2));
  for (const [name, src] of Object.entries(bundle.components)) put(`${prefix}components/${name}.tsx`, src);
  for (const [name, src] of Object.entries(bundle.scripts)) put(`${prefix}scripts/${name}.js`, src);
  for (const [name, content] of Object.entries(bundle.assets)) put(`${prefix}assets/${name.replace(/[\\/]/g, "_")}`, content);
}

type ManifestModule = PackageManifest["requires"]["modules"][number];

/** Manifest entries for modules; vendored files go under modules/ (shared by all pages of a package). */
export function writeModules(put: Put, modules: ModuleRef[], vendor: boolean, seen = new Map<string, ManifestModule>()): ManifestModule[] {
  const out: ManifestModule[] = [];
  for (const m of modules) {
    const key = `${m.name}@${m.version}`;
    const prev = seen.get(key);
    if (prev) {
      out.push(prev);
      continue;
    }
    const stored = findModule(m.name, m.version);
    const entry: ManifestModule = { name: m.name, version: m.version, hash: stored?.hash ?? m.hash, integrity: stored?.integrity ?? m.integrity, bundled: false, url: stored?.url ?? m.url, providesWidgets: m.providesWidgets };
    if (vendor || m.source === "bundled") {
      const mf = moduleFiles(m.name, m.version);
      if (mf) {
        const dir = `modules/${m.name.replace(/[@/]/g, "_")}@${m.version}`;
        entry.bundled = true;
        entry.files = {};
        for (const [h, content] of Object.entries(mf.files)) {
          put(`${dir}/${h}.mjs`, content);
          entry.files[h] = `${dir}/${h}.mjs`;
        }
        entry.file = `${dir}/${mf.entry}.mjs`;
      }
    }
    seen.set(key, entry);
    out.push(entry);
  }
  return out;
}

export async function exportPackage(
  projectId: string,
  page: PageRow,
  user: User,
  opts: { versionNo?: number; vendorModules?: boolean; sampleData?: boolean; anonymise?: boolean; gallery?: boolean },
) {
  const v = getVersion(page.id, opts.versionNo ?? page.current_version);
  const bundle = PageBundle.parse(v.bundle);
  const files: Record<string, Uint8Array> = {};
  const put = (p: string, content: string | Uint8Array) => (files[p] = typeof content === "string" ? strToU8(content) : content);

  writePageFiles(put, bundle);
  const pkgModules = writeModules(put, bundle.page.modules, opts.vendorModules ?? true);

  // data source requirements with column usage
  const req = v.requires as { skills?: Record<string, string>; sources?: Record<string, { skill?: string; dialect?: string; tables?: string[] }> };
  const sources: PackageManifest["requires"]["sources"] = [];
  for (const [alias, s] of Object.entries(req.sources ?? {})) {
    const entry = { alias, skill: s.skill, dialect: s.dialect, tables: s.tables ?? [], columns: {} as Record<string, string[]> };
    const inst = get<{ id: string }>("SELECT id FROM skill_instances WHERE project_id = ? AND alias = ?", projectId, alias);
    const snap = inst ? schemaOf(inst.id).snapshot : null;
    if (snap && s.dialect) {
      const tableCols = new Map<string, string[]>();
      for (const sch of snap.schemas) for (const t of sch.tables) {
        for (const ref of entry.tables) {
          const parts = ref.toLowerCase().split(".");
          if (parts[parts.length - 1] === t.name.toLowerCase() && (parts.length === 1 || parts[parts.length - 2] === sch.name.toLowerCase())) tableCols.set(ref, t.columns.map((c) => c.name));
        }
      }
      for (const d of bundle.page.datasets) {
        if (d.source !== alias || typeof d.request?.sql !== "string") continue;
        const use = sqlColumnUse(d.request.sql as string, s.dialect as Dialect, tableCols);
        for (const [t, cols] of Object.entries(use)) entry.columns[t] = [...new Set([...(entry.columns[t] ?? []), ...cols])];
      }
    }
    sources.push(entry);
  }

  // optional sample data (a snapshot taken with the exporter's account). Never in gallery packages: the gallery
  // shares the page and its design, not data. Never for per-user data sources: that data belongs to one login.
  const includeSample = !!opts.sampleData && !opts.gallery;
  let sampled = 0;
  if (includeSample) {
    const filters = defaultFilterValues(bundle.page.filters);
    const perUser = new Set(all<{ alias: string }>("SELECT alias FROM skill_instances WHERE project_id = ? AND credential_mode = 'user'", projectId).map((r) => r.alias));
    for (const d of bundle.page.datasets) {
      if (!d.source || !d.request || perUser.has(d.source)) continue;
      try {
        const r = await runQuery({ projectId, userId: user.id, alias: d.source, request: d.request, scope: { filters, page: { id: page.id, title: bundle.page.title } }, kind: "export", limits: { maxRows: 200 } });
        put(`sample/${d.id}.json`, JSON.stringify(r));
        sampled++;
      } catch {
        /* sample data is best effort */
      }
    }
  }

  const exporter = opts.anonymise ? undefined : { name: user.displayName ?? undefined, email: user.email ?? undefined };
  const manifest: PackageManifest = {
    spec: PACKAGE_SPEC,
    name: bundle.page.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "page",
    version: `1.0.${v.versionNo}`,
    title: bundle.page.title,
    description: bundle.page.description,
    exportedAt: now(),
    exportedBy: exporter,
    app: { name: "ai-bi", version: config.appVersion, minVersion: "0.1.0" },
    kind: "page",
    project: projectRef(projectId),
    page: { id: page.id, versionNo: v.versionNo, file: "page.json" },
    requires: {
      skills: Object.entries(req.skills ?? {}).map(([id, range]) => ({ id, range })),
      sources,
      modules: pkgModules,
    },
    contents: { components: Object.keys(bundle.components), scripts: Object.keys(bundle.scripts), assets: Object.keys(bundle.assets) },
    sampleData: sampled > 0,
    checksums: "CHECKSUMS.json",
  };
  put("manifest.json", JSON.stringify(manifest, null, 2));
  put("README.md", readme(manifest, bundle));
  const checksums: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) checksums[p] = sha256(Buffer.from(c));
  put("CHECKSUMS.json", JSON.stringify(checksums, null, 2));

  const zip = zipSync(files, { level: 6 });
  const id = newId("pkg");
  // only gallery packages are kept on the server; a plain download is handed to the user and forgotten
  if (opts.gallery) {
    const storage = path.join(config.packagesDir, `${id}.aibi`);
    fs.writeFileSync(storage, zip);
    run(
      "INSERT INTO packages (id, project_id, page_id, version_no, manifest, storage_path, size, kind, gallery, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      id, projectId, page.id, v.versionNo, json(manifest), storage, zip.length, "export", 1, user.id, now(),
    );
  }
  audit(projectId, user.id, "package.export", page.id, { packageId: id, versionNo: v.versionNo, vendorModules: opts.vendorModules ?? true, sampleData: !!opts.sampleData });
  return { id, filename: `${manifest.name}-${manifest.version}.aibi`, buffer: Buffer.from(zip), manifest };
}

function readme(m: PackageManifest, b: PageBundle): string {
  const lines = [
    `# ${m.title}`,
    "",
    m.description ?? "",
    "",
    `Exported ${m.exportedAt} from AI BI ${m.app.version}. Page version ${m.page.versionNo}.`,
    "",
    "## Requirements",
    "",
    "Skills:",
    ...m.requires.skills.map((s) => `- ${s.id} ${s.range}`),
    "",
    "Data sources (map these to your own connections on import):",
    ...m.requires.sources.map((s) => `- \`${s.alias}\` (${s.dialect ?? s.skill ?? "any"}): ${s.tables.join(", ") || "no tables detected"}`),
    "",
    "Modules:",
    ...(m.requires.modules.length ? m.requires.modules.map((x) => `- ${x.name}@${x.version}${x.bundled ? " (bundled)" : ""}`) : ["- none"]),
    "",
    "## Contents",
    "",
    `- ${b.page.filters.length} filters, ${b.page.datasets.length} datasets, ${b.page.widgets.length} widgets`,
    `- components: ${m.contents.components.join(", ") || "none"}`,
    `- scripts: ${m.contents.scripts.join(", ") || "none"}`,
    "",
    "This package contains no credentials and no data" + (m.sampleData ? " except the sample snapshot in sample/." : "."),
  ];
  return lines.join("\n");
}

/* ───────────────────────── import ───────────────────────── */

export interface ImportReport {
  importId: string;
  kind: "package" | "bundle" | "page";
  manifest: PackageManifest | null;
  title: string;
  pageId: string;
  stats: { filters: number; datasets: number; widgets: number; components: number; scripts: number; modules: number };
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
  skills: { id: string; range: string; status: "ok" | "disabled" | "missing" | "version"; installed?: string }[];
  modules: { name: string; version: string; status: "reused" | "vendored" | "fetch" | "missing"; bundled: boolean }[];
  sources: {
    alias: string;
    dialect?: string;
    skill?: string;
    tables: string[];
    candidates: { alias: string; name: string; skill: string; dialect?: string; coverage: { missingTables: string[]; missingColumns: Record<string, string[]>; ok: boolean; checked: boolean } }[];
    suggested: string | null;
  }[];
  /** project the package was exported from (null for packages without that information, e.g. local files) */
  origin: { id: string; slug: string; name: string } | null;
  conflict: { existingPageId: string; title: string; currentVersion: number } | null;
  modes: ("new" | "version" | "copy")[];
}

/** Unzip with the file-count and unpacked-size limits applied *before* inflating anything. */
export function unzipBounded(buf: Buffer | Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  let n = 0;
  return unzipSync(new Uint8Array(buf), {
    filter: (f) => {
      total += f.originalSize;
      if (++n > MAX_ZIP_FILES) throw badRequest("package has too many files");
      if (total > MAX_UNZIPPED) throw badRequest("package is too large when unpacked");
      return true;
    },
  });
}

function safeEntries(zip: Record<string, Uint8Array>) {
  const out: Record<string, Uint8Array> = {};
  let total = 0;
  let n = 0;
  for (const [p, data] of Object.entries(zip)) {
    if (p.endsWith("/")) continue;
    const norm = path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
    if (norm.startsWith("..") || norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) throw badRequest(`unsafe path in package: ${p}`);
    total += data.length;
    if (++n > MAX_ZIP_FILES) throw badRequest("package has too many files");
    if (total > MAX_UNZIPPED) throw badRequest("package is too large when unpacked");
    out[norm] = data;
  }
  // tolerate a single top-level folder (zipped directory)
  const roots = new Set(Object.keys(out).map((k) => k.split("/")[0]));
  if (!out["manifest.json"] && !out["page.json"] && roots.size === 1) {
    const root = [...roots][0] + "/";
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k.startsWith(root) ? k.slice(root.length) : k, v]));
  }
  return out;
}

export const isZip = (buf: Buffer) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;

/** Unpack a package zip safely (paths, size, file count) and verify CHECKSUMS.json when present. */
export function openZip(buf: Buffer, filename: string) {
  const warnings: { path: string; message: string }[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = safeEntries(unzipBounded(buf));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest(`could not unpack ${filename}: ${(e as Error).message}`);
  }
  const text = (p: string) => (entries[p] ? strFromU8(entries[p]) : undefined);
  const sums = text("CHECKSUMS.json");
  if (sums) {
    const expected = JSON.parse(sums) as Record<string, string>;
    for (const [p, h] of Object.entries(expected)) {
      if (!entries[p]) throw badRequest(`package is incomplete: ${p} is missing`);
      if (sha256(Buffer.from(entries[p])) !== h) throw badRequest(`checksum mismatch for ${p}; the package was modified or corrupted`);
    }
  } else warnings.push({ path: "CHECKSUMS.json", message: "package has no checksums (hand-made folder?)" });
  return { entries, text, warnings };
}

/** Components, scripts and assets of one page stored under `prefix` in a package. */
export function pageExtras(entries: Record<string, Uint8Array>, prefix = "") {
  const components: Record<string, string> = {};
  const scripts: Record<string, string> = {};
  const assets: Record<string, string> = {};
  for (const [full, data] of Object.entries(entries)) {
    if (!full.startsWith(prefix)) continue;
    const p = full.slice(prefix.length);
    if (p.startsWith("components/") && /\.(tsx|jsx|ts|js)$/.test(p)) components[path.posix.basename(p).replace(/\.(tsx|jsx|ts|js)$/, "")] = strFromU8(data);
    else if (p.startsWith("scripts/") && /\.(m?js|ts)$/.test(p)) scripts[path.posix.basename(p).replace(/\.(m?js|ts)$/, "")] = strFromU8(data);
    else if (p.startsWith("assets/")) assets[p.slice(7)] = strFromU8(data);
  }
  return { components, scripts, assets };
}

/** Turn uploaded bytes into a bundle + manifest. Accepts .aibi/.zip packages, PageBundle JSON or page JSON. */
export function readUpload(buf: Buffer, filename: string): { bundle: PageBundleInput; manifest: PackageManifest | null; kind: ImportReport["kind"]; moduleFilesInPkg: Record<string, string>; warnings: { path: string; message: string }[] } {
  const warnings: { path: string; message: string }[] = [];
  if (!isZip(buf)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      throw badRequest(`${filename} is neither a .aibi package nor JSON`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj && typeof obj === "object" && "page" in obj) return { bundle: obj as PageBundleInput, manifest: null, kind: "bundle", moduleFilesInPkg: {}, warnings };
    return { bundle: { page: obj as never, components: {}, scripts: {}, assets: {} }, manifest: null, kind: "page", moduleFilesInPkg: {}, warnings };
  }
  const { entries, text, warnings: zipWarnings } = openZip(buf, filename);
  warnings.push(...zipWarnings);

  let manifest: PackageManifest | null = null;
  const mtext = text("manifest.json");
  if (mtext) {
    const raw = JSON.parse(mtext) as { kind?: string };
    if (raw?.kind === "project") throw badRequest(`${filename} is a project package. Import it from the Projects page (Import project), not as a page.`);
    const m = PackageManifest.safeParse(raw);
    if (!m.success) throw badRequest(`manifest.json is invalid: ${m.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    manifest = m.data;
  }
  const ptext = text("page.json");
  if (!ptext) throw badRequest("package has no page.json");
  const pageJson = JSON.parse(ptext) as Record<string, unknown>;
  const pageObj = ("page" in pageJson ? pageJson.page : pageJson) as Record<string, unknown>;
  const { components, scripts, assets } = pageExtras(entries);
  return { bundle: { page: pageObj as never, components, scripts, assets }, manifest, kind: "package", moduleFilesInPkg: moduleFilesOf(entries), warnings };
}

export function moduleFilesOf(entries: Record<string, Uint8Array>) {
  const out: Record<string, string> = {};
  for (const [p, data] of Object.entries(entries)) if (p.startsWith("modules/") && p.endsWith(".mjs")) out[p] = strFromU8(data);
  return out;
}

function coverage(projectId: string, instAlias: string, tables: string[], columns: Record<string, string[]> | undefined) {
  const inst = get<{ id: string }>("SELECT id FROM skill_instances WHERE project_id = ? AND alias = ?", projectId, instAlias);
  const snap = inst ? schemaOf(inst.id).snapshot : null;
  if (!snap) return { missingTables: [], missingColumns: {}, ok: true, checked: false };
  const missingTables: string[] = [];
  const missingColumns: Record<string, string[]> = {};
  for (const ref of tables) {
    const parts = ref.toLowerCase().split(".");
    const name = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[parts.length - 2] : null;
    let found: { columns: { name: string }[] } | undefined;
    for (const s of snap.schemas) {
      if (schema && s.name.toLowerCase() !== schema && snap.schemas.length > 1) continue;
      found = s.tables.find((t) => t.name.toLowerCase() === name) ?? found;
    }
    if (!found) {
      missingTables.push(ref);
      continue;
    }
    const want = columns?.[ref] ?? [];
    const have = new Set(found.columns.map((c) => c.name.toLowerCase()));
    const miss = want.filter((c) => !have.has(c.toLowerCase()));
    if (miss.length) missingColumns[ref] = miss;
  }
  return { missingTables, missingColumns, ok: !missingTables.length && !Object.keys(missingColumns).length, checked: true };
}

export async function analyzeImport(projectId: string, user: User, buf: Buffer, filename: string, opts: { template?: boolean } = {}): Promise<ImportReport> {
  const up = readUpload(buf, filename);
  const importId = newId("imp");
  const storage = path.join(config.dataDir, "imports", `${importId}.bin`);
  fs.writeFileSync(storage, buf);

  const cat = catalogueFor(projectId);
  const parsed = PageBundle.safeParse(up.bundle);
  const errors: ImportReport["errors"] = [];
  const warnings: ImportReport["warnings"] = [...up.warnings];
  let bundle: PageBundle | null = null;
  if (!parsed.success) errors.push(...parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  else {
    bundle = parsed.data;
    // validate without source checks: sources are remapped on commit
    const v = validatePage(bundle, { catalogue: { ...cat, sources: [] }, strictCatalogue: false });
    errors.push(...v.errors);
    warnings.push(...v.warnings.filter((w) => !/unknown data source/.test(w.message)));
    if (v.requires) bundle.page.requires = v.requires;
  }
  const page = bundle?.page;

  // a page package belongs to one project: import it only there (same id, or same slug on another server).
  // Platform templates are meant for every project and are exempt.
  const origin = up.manifest?.project ?? null;
  if (origin && !opts.template) {
    const target = projectRef(projectId);
    if (origin.id !== target.id && origin.slug !== target.slug) {
      errors.push({ path: "manifest.project", message: `This page was exported from project “${origin.name}” (${origin.slug}). A page package can only be imported into the project it came from; open that project to import it, or export the whole project instead.` });
    }
  }

  // skills
  const enabled = new Map(enabledSkills(projectId).map((s) => [s.manifest.id, s.manifest.version]));
  const required = up.manifest?.requires.skills ?? Object.entries(page?.requires?.skills ?? {}).map(([id, range]) => ({ id, range }));
  const skills: ImportReport["skills"] = required.map((r) => {
    const inst = enabled.get(r.id);
    if (inst) return { ...r, status: satisfies(inst, r.range) ? "ok" : "version", installed: inst };
    const exists = getSkill(r.id);
    return { ...r, status: exists ? "disabled" : "missing", installed: exists?.manifest.version };
  });
  for (const s of skills) {
    if (s.status === "missing") errors.push({ path: `skills.${s.id}`, message: `skill '${s.id}' is not installed on this server` });
    if (s.status === "disabled") warnings.push({ path: `skills.${s.id}`, message: `skill '${s.id}' is installed but disabled in this project; it will be enabled on import` });
    if (s.status === "version") warnings.push({ path: `skills.${s.id}`, message: `page was built for ${s.id} ${s.range}; this project has ${s.installed}` });
  }

  // modules
  const pkgMods = new Map((up.manifest?.requires.modules ?? []).map((m) => [`${m.name}@${m.version}`, m]));
  const modules: ImportReport["modules"] = (page?.modules ?? []).map((m) => {
    const pm = pkgMods.get(`${m.name}@${m.version}`);
    const stored = findModule(m.name, m.version);
    if (stored && stored.source !== "bundled" && m.source !== "bundled" && (!pm?.hash || stored.hash === pm.hash)) return { name: m.name, version: m.version, status: "reused", bundled: !!pm?.bundled };
    // registry and URL modules are always fetched from an allow-listed host, never taken from the package
    if (m.source !== "bundled") return { name: m.name, version: m.version, status: "fetch", bundled: false };
    if (stored && stored.hash === pm?.hash) return { name: m.name, version: m.version, status: "reused", bundled: true };
    if (pm?.bundled && pm.file && up.moduleFilesInPkg[pm.file]) return { name: m.name, version: m.version, status: "vendored", bundled: true };
    return { name: m.name, version: m.version, status: "missing", bundled: false };
  });
  for (const m of modules) if (m.status === "missing") errors.push({ path: `modules.${m.name}`, message: "bundled module is missing from the package" });

  // data sources
  const instances = listInstances(projectId).filter((i) => i.status !== "disabled");
  const requiredSources = up.manifest?.requires.sources ??
    Object.entries(page?.requires?.sources ?? {}).map(([alias, s]) => ({ alias, skill: s.skill, dialect: s.dialect, tables: s.tables ?? [], columns: s.columns }));
  // make sure candidate schemas are introspected for coverage
  for (const i of instances) {
    if (!schemaOf(i.id).snapshot) {
      try {
        await ensureSchema(projectId, i.alias, user.id);
      } catch {
        /* unreachable sources are still offered */
      }
    }
  }
  const sources: ImportReport["sources"] = requiredSources.map((s) => {
    const candidates = instances
      .filter((i) => {
        const caps = (getSkill(i.skill_id)?.manifest.capabilities ?? {}) as { dialect?: string; kind?: string };
        if (s.dialect) return caps.dialect === s.dialect;
        if (s.skill) return i.skill_id === s.skill;
        return true;
      })
      .map((i) => ({
        alias: i.alias,
        name: i.name,
        skill: i.skill_id,
        dialect: ((getSkill(i.skill_id)?.manifest.capabilities ?? {}) as { dialect?: string }).dialect,
        coverage: coverage(projectId, i.alias, s.tables, s.columns),
      }));
    const same = candidates.find((c) => c.alias === s.alias);
    const best = same ?? candidates.find((c) => c.coverage.ok) ?? candidates[0];
    return { alias: s.alias, dialect: s.dialect, skill: s.skill, tables: s.tables, candidates, suggested: best?.alias ?? null };
  });
  for (const s of sources) if (!s.candidates.length) warnings.push({ path: `sources.${s.alias}`, message: `no ${s.dialect ?? s.skill ?? ""} data source in this project; add one or the page's datasets will not load` });

  // conflict
  // an existing page is a conflict only when the importer may edit it; another member's private page is
  // neither revealed nor overwritable, the import can only become a copy
  const role = memberRole(projectId, user);
  const existing = page?.id ? get<PageRow>("SELECT * FROM pages WHERE id = ? AND project_id = ? AND deleted = 0", page.id, projectId) : undefined;
  const editable = !!existing && !!role && canEdit(existing, user, role);
  const conflict = existing && editable ? { existingPageId: existing.id, title: existing.title, currentVersion: existing.current_version } : null;
  const taken = !!existing && !editable;

  const report: ImportReport = {
    importId,
    kind: up.kind,
    manifest: up.manifest,
    title: page?.title ?? up.manifest?.title ?? filename,
    pageId: page?.id ?? "",
    stats: {
      filters: page?.filters.length ?? 0,
      datasets: page?.datasets.length ?? 0,
      widgets: page?.widgets.length ?? 0,
      components: page?.components.length ?? 0,
      scripts: page?.scripts.length ?? 0,
      modules: page?.modules.length ?? 0,
    },
    errors,
    warnings,
    skills,
    modules,
    sources,
    origin,
    conflict,
    modes: conflict ? ["version", "copy"] : taken ? ["copy"] : ["new"],
  };
  run("INSERT INTO imports (id, project_id, user_id, storage_path, report, status, created_at) VALUES (?,?,?,?,?,?,?)", importId, projectId, user.id, storage, json(report), "analyzed", now());
  return report;
}

export function getImport(projectId: string, importId: string, user: User) {
  const r = get<{ id: string; user_id: string; storage_path: string; report: string; status: string }>("SELECT * FROM imports WHERE id = ? AND project_id = ?", importId, projectId);
  if (!r || r.user_id !== user.id) throw notFound("Import not found");
  return { ...r, report: parse<ImportReport>(r.report, null as never) };
}

export function enableSkill(projectId: string, skillId: string) {
  if (get("SELECT 1 FROM project_skills WHERE project_id = ? AND skill_id = ?", projectId, skillId)) run("UPDATE project_skills SET enabled = 1 WHERE project_id = ? AND skill_id = ?", projectId, skillId);
  else run("INSERT INTO project_skills (project_id, skill_id, enabled, settings) VALUES (?,?,1,'{}')", projectId, skillId);
}

/**
 * Store the bundled modules shipped in a package and attach every module a page uses to the project.
 * Only modules whose source is "bundled" are taken from the package: code for a registry or URL module is
 * always fetched from an allow-listed host when the page is saved, so a package can never plant code under
 * a public package name for other projects.
 */
export function installModules(projectId: string, user: User, pageModules: ModuleRef[], manifestModules: ManifestModule[], moduleFilesInPkg: Record<string, string>) {
  const pkgMods = new Map(manifestModules.map((m) => [`${m.name}@${m.version}`, m]));
  for (const m of pageModules) {
    const pm = pkgMods.get(`${m.name}@${m.version}`);
    if (m.source === "bundled" && pm?.bundled && pm.file && moduleFilesInPkg[pm.file] && !findModule(m.name, m.version)) {
      const extra: Record<string, string> = {};
      for (const [h, p] of Object.entries(pm.files ?? {})) if (p !== pm.file && moduleFilesInPkg[p]) extra[h] = moduleFilesInPkg[p];
      storeVendored({ name: m.name, version: m.version, entryContent: moduleFilesInPkg[pm.file], extra, source: m.source, url: pm.url, providesWidgets: pm.providesWidgets });
    }
    if (findModule(m.name, m.version)) attachToProject(projectId, m.name, m.version, user.id);
  }
}

/** Rewrite data source aliases in a bundle. */
export function remapSources(bundle: PageBundle, mapping: Record<string, string>) {
  for (const d of bundle.page.datasets) if (d.source && mapping[d.source]) d.source = mapping[d.source];
  return bundle;
}

export async function commitImport(
  projectId: string,
  user: User,
  importId: string,
  opts: { mapping: Record<string, string>; mode: "new" | "version" | "copy"; title?: string; sqlOverrides?: Record<string, string>; enableSkills?: boolean; overwrite?: boolean },
) {
  const imp = getImport(projectId, importId, user);
  if (imp.status === "committed") throw badRequest("This import was already completed");
  const rep = imp.report;
  if (rep.errors.length) throw new HttpError(422, "The package has errors; fix them before importing", { errors: rep.errors, warnings: rep.warnings });
  if (!rep.modes.includes(opts.mode)) throw badRequest(`mode must be one of ${rep.modes.join(", ")}`);
  if (opts.mode === "version" && rep.conflict && !opts.overwrite) {
    throw new HttpError(409, `Page “${rep.conflict.title}” already exists in this project. Confirm to overwrite it (the current version stays in its history), or import as a copy.`, { code: "confirm_overwrite", conflict: rep.conflict });
  }
  const up = readUpload(fs.readFileSync(imp.storage_path), "upload");
  const bundle = PageBundle.parse(up.bundle);

  // enable required skills that are installed but disabled
  if (opts.enableSkills !== false) for (const s of rep.skills) if (s.status === "disabled") enableSkill(projectId, s.id);

  installModules(projectId, user, bundle.page.modules, up.manifest?.requires.modules ?? [], up.moduleFilesInPkg);

  // data source mapping
  const mapping: Record<string, string> = {};
  for (const s of rep.sources) {
    const target = opts.mapping[s.alias] ?? s.suggested;
    if (!target) throw badRequest(`choose a data source for '${s.alias}'`);
    if (!get("SELECT 1 FROM skill_instances WHERE project_id = ? AND alias = ?", projectId, target)) throw badRequest(`no data source '${target}' in this project`);
    mapping[s.alias] = target;
  }
  remapSources(bundle, mapping);
  for (const [datasetId, sql] of Object.entries(opts.sqlOverrides ?? {})) {
    const d = bundle.page.datasets.find((x) => x.id === datasetId);
    if (d?.request) d.request.sql = sql;
  }
  if (opts.title) bundle.page.title = opts.title;

  let result: { id: string; versionNo: number; warnings: unknown[] };
  if (opts.mode === "version" && rep.conflict) {
    const role = memberRole(projectId, user) ?? "viewer";
    const page = loadPage(projectId, rep.conflict.existingPageId, user, role, "edit");
    result = await saveVersion(projectId, page, user, bundle, { message: `Imported ${rep.manifest ? `package ${rep.manifest.name}@${rep.manifest.version}` : "page"}`, source: "import" });
  } else {
    result = await createPage(projectId, user, bundle, { message: `Imported${rep.manifest ? ` from package ${rep.manifest.name}@${rep.manifest.version}` : ""}`, source: "import", keepId: opts.mode === "new" });
  }
  run("UPDATE imports SET status = 'committed' WHERE id = ?", importId);
  run(
    "INSERT INTO packages (id, project_id, page_id, version_no, manifest, storage_path, size, kind, gallery, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    newId("pkg"), projectId, result.id, result.versionNo, json(rep.manifest ?? {}), imp.storage_path, fs.statSync(imp.storage_path).size, "import", 0, user.id, now(),
  );
  audit(projectId, user.id, "package.import", result.id, { importId, mode: opts.mode, mapping });
  return result;
}

/** Gallery: packages published in this project plus platform templates (page and design; no data, no logins). */
export function gallery(projectId: string) {
  return all<{ id: string; project_id: string; page_id: string | null; version_no: number | null; manifest: string; size: number; kind: string; created_at: string; email: string | null }>(
    `SELECT p.*, u.email FROM packages p LEFT JOIN users u ON u.id = p.created_by
     WHERE (p.project_id = ? AND p.gallery = 1) OR p.kind = 'template' ORDER BY p.created_at DESC`,
    projectId,
  ).map((p) => {
    const m = parse<PackageManifest | null>(p.manifest, null);
    return { id: p.id, kind: p.kind, title: m?.title ?? "Untitled", description: m?.description, version: m?.version, size: p.size, createdAt: p.created_at, createdBy: p.email, requires: m?.requires };
  });
}

/**
 * Remove any data snapshot (sample/…) from a package and fix its manifest and checksums. Gallery and template
 * packages are served through this, so packages published before the rule can never hand out someone's data.
 */
export function withoutSampleData(buf: Buffer): Buffer {
  const files = unzipBounded(buf);
  const hasSample = Object.keys(files).some((p) => /(^|\/)sample\//.test(p));
  const mtext = files["manifest.json"] ? JSON.parse(strFromU8(files["manifest.json"])) as { sampleData?: boolean } : null;
  if (!hasSample && !mtext?.sampleData) return buf;
  const out: Record<string, Uint8Array> = {};
  for (const [p, data] of Object.entries(files)) if (!/(^|\/)sample\//.test(p) && p !== "CHECKSUMS.json") out[p] = data;
  if (mtext) out["manifest.json"] = strToU8(JSON.stringify({ ...mtext, sampleData: false }, null, 2));
  if (out["README.md"]) out["README.md"] = strToU8(strFromU8(out["README.md"]).replace(" except the sample snapshot in sample/.", "."));
  if (files["CHECKSUMS.json"]) {
    const sums: Record<string, string> = {};
    for (const [p, data] of Object.entries(out)) sums[p] = sha256(Buffer.from(data));
    out["CHECKSUMS.json"] = strToU8(JSON.stringify(sums, null, 2));
  }
  return Buffer.from(zipSync(out, { level: 6 }));
}

/** A package from the project gallery or the platform templates: page and design only, never data. */
export function packageFile(id: string, projectId: string) {
  const p = get<{ storage_path: string; manifest: string; project_id: string; kind: string; gallery: number }>("SELECT * FROM packages WHERE id = ?", id);
  if (!p || !((p.project_id === projectId && p.gallery === 1) || p.kind === "template")) throw notFound("Package not found");
  const m = parse<PackageManifest | null>(p.manifest, null);
  return { buffer: withoutSampleData(fs.readFileSync(p.storage_path)), filename: `${m?.name ?? "page"}-${m?.version ?? "1.0.0"}.aibi`, kind: p.kind };
}

export { PageDefinition, checkReadOnly };
export type { ModuleRef };

/**
 * Remove uploads that were analysed but never imported after `maxAgeHours` (page imports have a row in
 * `imports`; project imports keep a `.json` record next to the upload). Committed page imports keep their
 * file because the `packages` row of the import points at it.
 */
export function sweepImports(maxAgeHours = 24) {
  const cutoff = Date.now() - maxAgeHours * 3600_000;
  let removed = 0;
  for (const r of all<{ id: string; storage_path: string }>("SELECT id, storage_path FROM imports WHERE status <> 'committed' AND created_at < ?", new Date(cutoff).toISOString())) {
    try {
      fs.rmSync(r.storage_path, { force: true });
    } catch {
      /* already gone */
    }
    run("DELETE FROM imports WHERE id = ?", r.id);
    removed++;
  }
  const dir = path.join(config.dataDir, "imports");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith("pim_") || !f.endsWith(".json")) continue;
      const file = path.join(dir, f);
      try {
        const rec = JSON.parse(fs.readFileSync(file, "utf8")) as { status?: string };
        if (fs.statSync(file).mtimeMs < cutoff && rec.status !== "committed") {
          fs.rmSync(file, { force: true });
          fs.rmSync(file.replace(/\.json$/, ".bin"), { force: true });
          removed++;
        }
      } catch {
        /* unreadable record: leave it */
      }
    }
  }
  return removed;
}
