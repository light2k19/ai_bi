import fs from "node:fs";
import path from "node:path";
import type { ModuleRef } from "@aibi/page-spec";
import { config } from "../config";
import { all, get, run, now, json, parse } from "../db";
import { sha256, sri } from "../lib/crypto";
import { badRequest, HttpError } from "../lib/errors";
import { projectSettings } from "../skills/registry";
import { audit } from "./audit";

const MAX_FILES = 80;
const MAX_TOTAL_BYTES = 12_000_000;
const SPEC_RES = [
  /\b(?:import|export)\b[^"'();=]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export const moduleFile = (hash: string) => path.join(config.modulesDir, `${hash}.mjs`);
export const moduleUrl = (hash: string) => `${config.publicApiUrl}/api/modules/${hash}.mjs`;

export function allowedHosts(projectId: string): string[] {
  const s = projectSettings(projectId).moduleHosts as string[] | undefined;
  return s?.length ? s : config.moduleHosts;
}

export function registryUrl(name: string, version: string, registry = "esm.sh"): string {
  switch (registry) {
    case "jsdelivr":
    case "cdn.jsdelivr.net":
      return `https://cdn.jsdelivr.net/npm/${name}@${version}/+esm`;
    case "unpkg":
    case "unpkg.com":
      return `https://unpkg.com/${name}@${version}?module`;
    default:
      return `https://esm.sh/${name}@${version}?bundle&target=es2022`;
  }
}

function storeFile(content: string, originUrl: string | null): string {
  const hash = sha256(content);
  const f = moduleFile(hash);
  if (!fs.existsSync(f)) fs.writeFileSync(f, content);
  if (!get("SELECT 1 FROM module_files WHERE hash = ?", hash)) run("INSERT INTO module_files (hash, size, origin_url, created_at) VALUES (?,?,?,?)", hash, Buffer.byteLength(content), originUrl, now());
  return hash;
}

/**
 * Fetch a module and everything it imports by URL or absolute path, rewrite those imports to
 * content-addressed sibling files, and store all files. Bare specifiers (e.g. "react") are left
 * for the runtime import map.
 */
async function vendor(entryUrl: string, hosts: string[]): Promise<{ hash: string; files: string[] }> {
  const visited = new Map<string, string>(); // url -> hash
  let total = 0;
  const inProgress = new Set<string>();

  async function fetchOne(url: string): Promise<string> {
    const done = visited.get(url);
    if (done) return done;
    if (inProgress.has(url)) throw badRequest(`circular module import at ${url}`);
    const u = new URL(url);
    if (u.protocol !== "https:") throw badRequest(`module URLs must use https (${url})`);
    if (!hosts.includes(u.host)) throw badRequest(`module host '${u.host}' is not allowed (allowed: ${hosts.join(", ")})`);
    if (visited.size >= MAX_FILES) throw badRequest(`module has more than ${MAX_FILES} files; use a bundled build`);
    inProgress.add(url);
    const r = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (ai-bi module vendoring)" } });
    if (!r.ok) throw badRequest(`fetching ${url} failed: HTTP ${r.status}`);
    const finalUrl = r.url || url;
    if (!hosts.includes(new URL(finalUrl).host)) throw badRequest(`module redirected to a host that is not allowed: ${finalUrl}`);
    let text = await r.text();
    total += text.length;
    if (total > MAX_TOTAL_BYTES) throw badRequest(`module is larger than ${MAX_TOTAL_BYTES / 1e6} MB`);
    const specs = new Set<string>();
    for (const re of SPEC_RES) for (const m of text.matchAll(re)) specs.add(m[1]);
    const replacements = new Map<string, string>();
    for (const s of specs) {
      if (!(s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("https://"))) continue;
      const child = new URL(s, finalUrl).toString();
      const h = await fetchOne(child);
      replacements.set(s, `./${h}.mjs`);
    }
    for (const [from, to] of replacements) text = text.split(`"${from}"`).join(`"${to}"`).split(`'${from}'`).join(`'${to}'`);
    const hash = storeFile(text, url);
    visited.set(url, hash);
    inProgress.delete(url);
    return hash;
  }

  const hash = await fetchOne(entryUrl);
  return { hash, files: [...new Set(visited.values())] };
}

export interface ResolvedModule {
  name: string;
  version: string;
  hash: string;
  integrity: string;
  source: ModuleRef["source"];
  url?: string;
  files: string[];
  providesWidgets: string[];
}

function rowToResolved(r: { name: string; version: string; hash: string; integrity: string; source: string; url: string | null; files: string; provides_widgets: string }): ResolvedModule {
  return { name: r.name, version: r.version, hash: r.hash, integrity: r.integrity, source: r.source as ModuleRef["source"], url: r.url ?? undefined, files: parse(r.files, []), providesWidgets: parse(r.provides_widgets, []) };
}

export function findModule(name: string, version: string) {
  const r = get<Parameters<typeof rowToResolved>[0]>("SELECT * FROM modules WHERE name = ? AND version = ?", name, version);
  return r ? rowToResolved(r) : null;
}

export async function resolveModule(projectId: string, ref: Pick<ModuleRef, "name" | "version" | "source" | "registry" | "url" | "providesWidgets">, userId: string): Promise<ResolvedModule> {
  if (!/^\d+\.\d+\.\d+/.test(ref.version)) throw badRequest(`module ${ref.name}: use an exact version (got '${ref.version}')`);
  let m = findModule(ref.name, ref.version);
  // a row that came from an upload or a package never satisfies a registry/URL reference: fetch the real thing
  if (m && m.source === "bundled" && ref.source !== "bundled") m = null;
  if (!m) {
    if (ref.source === "bundled") throw badRequest(`bundled module ${ref.name}@${ref.version} is not in the module store; upload it first`);
    const hosts = allowedHosts(projectId);
    const url = ref.source === "url" && ref.url ? ref.url : registryUrl(ref.name, ref.version, ref.registry);
    const { hash, files } = await vendor(url, hosts);
    const integrity = sri(fs.readFileSync(moduleFile(hash)));
    run(
      "INSERT OR REPLACE INTO modules (name, version, hash, integrity, source, url, provides_widgets, files, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ref.name, ref.version, hash, integrity, ref.source, url, json(ref.providesWidgets ?? []), json(files), now(),
    );
    m = findModule(ref.name, ref.version)!;
  }
  attachToProject(projectId, m.name, m.version, userId);
  return m;
}

/** Store an uploaded or package-vendored module (files keyed by their sha256). */
export function storeVendored(input: { name: string; version: string; entryContent: string; extra?: Record<string, string>; source: ModuleRef["source"]; url?: string; providesWidgets?: string[] }) {
  for (const [h, content] of Object.entries(input.extra ?? {})) {
    if (sha256(content) !== h) throw badRequest(`module ${input.name}: file hash mismatch`);
    storeFile(content, input.url ?? null);
  }
  const hash = storeFile(input.entryContent, input.url ?? null);
  const integrity = sri(input.entryContent);
  const existing = findModule(input.name, input.version);
  if (existing && existing.hash !== hash) throw new HttpError(409, `module ${input.name}@${input.version} already exists with different content`);
  if (!existing) {
    run(
      "INSERT INTO modules (name, version, hash, integrity, source, url, provides_widgets, files, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      input.name, input.version, hash, integrity, input.source, input.url ?? null, json(input.providesWidgets ?? []), json([hash, ...Object.keys(input.extra ?? {})]), now(),
    );
  }
  return findModule(input.name, input.version)!;
}

export function attachToProject(projectId: string, name: string, version: string, userId: string) {
  if (get("SELECT 1 FROM project_modules WHERE project_id = ? AND name = ? AND version = ?", projectId, name, version)) return;
  const needsApproval = projectSettings(projectId).moduleApproval === true;
  run("INSERT INTO project_modules (project_id, name, version, status, added_by, added_at) VALUES (?,?,?,?,?,?)", projectId, name, version, needsApproval ? "pending" : "approved", userId, now());
  audit(projectId, userId, "module.add", `${name}@${version}`, { status: needsApproval ? "pending" : "approved" });
}

export function projectModules(projectId: string) {
  return all<{ name: string; version: string; status: string; added_by: string | null; added_at: string }>("SELECT * FROM project_modules WHERE project_id = ? ORDER BY name, version", projectId).map((r) => {
    const m = findModule(r.name, r.version);
    const size = m ? (get<{ size: number }>("SELECT size FROM module_files WHERE hash = ?", m.hash)?.size ?? 0) : 0;
    return { name: r.name, version: r.version, status: r.status, addedBy: r.added_by, addedAt: r.added_at, hash: m?.hash, integrity: m?.integrity, url: m?.url, size, files: m?.files.length ?? 0 };
  });
}

export function setModuleStatus(projectId: string, name: string, version: string, status: "approved" | "rejected", userId: string) {
  run("UPDATE project_modules SET status = ? WHERE project_id = ? AND name = ? AND version = ?", status, projectId, name, version);
  audit(projectId, userId, `module.${status}`, `${name}@${version}`);
}

/** Make sure each module ref is in the store and approved for the project; fills hash and integrity. */
export async function ensureModulesResolved(projectId: string, mods: ModuleRef[], userId: string): Promise<ModuleRef[]> {
  const out: ModuleRef[] = [];
  for (const m of mods) {
    const r = await resolveModule(projectId, m, userId);
    const status = get<{ status: string }>("SELECT status FROM project_modules WHERE project_id = ? AND name = ? AND version = ?", projectId, m.name, m.version)?.status;
    if (status === "pending") throw new HttpError(422, `Module ${m.name}@${m.version} is waiting for a project admin to approve it`, { errors: [{ path: `modules.${m.name}`, message: "awaiting approval" }], warnings: [] });
    if (status === "rejected") throw new HttpError(422, `Module ${m.name}@${m.version} was rejected by a project admin`, { errors: [{ path: `modules.${m.name}`, message: "rejected" }], warnings: [] });
    out.push({ ...m, hash: r.hash, integrity: r.integrity, providesWidgets: m.providesWidgets ?? (r.providesWidgets.length ? r.providesWidgets : undefined) });
  }
  return out;
}

/** Import map entries for the runtime: name → store URL (+ integrity). */
export function importMapFor(mods: ModuleRef[]) {
  const imports: Record<string, string> = {};
  const integrity: Record<string, string> = {};
  for (const m of mods) {
    const r = m.hash ? { hash: m.hash, integrity: m.integrity } : findModule(m.name, m.version);
    if (!r?.hash) continue;
    const url = moduleUrl(r.hash);
    imports[m.name] = url;
    if (r.integrity) integrity[url] = r.integrity;
  }
  return { imports, integrity };
}

/** All file contents of a module (for packaging). */
export function moduleFiles(name: string, version: string): { entry: string; files: Record<string, string> } | null {
  const m = findModule(name, version);
  if (!m) return null;
  const files: Record<string, string> = {};
  for (const h of m.files) if (fs.existsSync(moduleFile(h))) files[h] = fs.readFileSync(moduleFile(h), "utf8");
  if (!files[m.hash]) files[m.hash] = fs.readFileSync(moduleFile(m.hash), "utf8");
  return { entry: m.hash, files };
}
