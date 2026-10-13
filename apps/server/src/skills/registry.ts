import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SkillManifest, type ServerSkillModule, type DatasourceHandler } from "@aibi/skill-sdk";
import type { Catalogue, WidgetTypeInfo, FilterTypeInfo, ScriptLibInfo, TransformInfo, SourceInfo } from "@aibi/page-spec";
import { ANIM_DOCS, COMPONENT_DOCS, PAGE_API_DOCS } from "@aibi/runtime-api/docs";
import { config } from "../config";
import { all, get, run, now, parse, json } from "../db";
import { sha256 } from "../lib/crypto";

export interface LoadedSkill {
  manifest: SkillManifest;
  dir: string;
  source: "builtin" | "uploaded";
  approved: boolean;
  server?: ServerSkillModule;
  instructions: string;
  loadError?: string;
}

const skills = new Map<string, LoadedSkill>();
const log = (m: string) => console.log(`[skills] ${m}`);

function readManifest(dir: string): SkillManifest | null {
  const f = path.join(dir, "skill.json");
  if (!fs.existsSync(f)) return null;
  const parsed = SkillManifest.safeParse(JSON.parse(fs.readFileSync(f, "utf8")));
  if (!parsed.success) {
    log(`invalid manifest in ${dir}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return null;
  }
  return parsed.data;
}

function dirChecksum(dir: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  return sha256(files.sort().map((f) => `${path.relative(dir, f)}:${sha256(fs.readFileSync(f))}`).join("\n"));
}

async function loadOne(dir: string, source: "builtin" | "uploaded", approved: boolean): Promise<LoadedSkill | null> {
  const manifest = readManifest(dir);
  if (!manifest) return null;
  const instrFile = path.join(dir, manifest.ai.instructions);
  let instructions = fs.existsSync(instrFile) ? fs.readFileSync(instrFile, "utf8").trim() : "";
  if (manifest.id === "script-anime") instructions += `\n\n${ANIM_DOCS}\n\n${PAGE_API_DOCS}`;
  if (manifest.id === "visual-custom") instructions += `\n\n${COMPONENT_DOCS}`;
  const s: LoadedSkill = { manifest, dir, source, approved, instructions };
  if (manifest.server && approved) {
    try {
      const mod = (await import(pathToFileURL(path.join(dir, manifest.server)).href)) as { default?: ServerSkillModule };
      s.server = mod.default;
      await s.server?.init?.({ dataDir: config.dataDir, log: (m) => log(`${manifest.id}: ${m}`) });
    } catch (e) {
      s.loadError = (e as Error).message;
      log(`failed to load server code of ${manifest.id}: ${s.loadError}`);
    }
  }
  return s;
}

export async function loadSkills() {
  skills.clear();
  const builtin = fs.existsSync(config.skillsDir) ? fs.readdirSync(config.skillsDir).map((d) => path.join(config.skillsDir, d)) : [];
  const uploaded = fs.existsSync(config.uploadedSkillsDir) ? fs.readdirSync(config.uploadedSkillsDir).map((d) => path.join(config.uploadedSkillsDir, d)) : [];
  for (const dir of builtin) {
    if (!fs.statSync(dir).isDirectory()) continue;
    const s = await loadOne(dir, "builtin", true);
    if (s) register(s);
  }
  for (const dir of uploaded) {
    if (!fs.statSync(dir).isDirectory()) continue;
    const m = readManifest(dir);
    if (!m) continue;
    const row = get<{ approved: number }>("SELECT approved FROM skills WHERE id = ? AND version = ?", m.id, m.version);
    const s = await loadOne(dir, "uploaded", row?.approved === 1);
    if (s) register(s);
  }
  log(`loaded ${skills.size} skills`);
}

function register(s: LoadedSkill) {
  const prev = skills.get(s.manifest.id);
  // newest approved version wins
  if (prev && prev.approved && (!s.approved || compareSemver(prev.manifest.version, s.manifest.version) >= 0)) return;
  skills.set(s.manifest.id, s);
  const existing = get("SELECT 1 FROM skills WHERE id = ? AND version = ?", s.manifest.id, s.manifest.version);
  const checksum = dirChecksum(s.dir);
  if (existing) run("UPDATE skills SET manifest = ?, path = ?, checksum = ?, type = ? WHERE id = ? AND version = ?", json(s.manifest), s.dir, checksum, s.manifest.type, s.manifest.id, s.manifest.version);
  else run("INSERT INTO skills (id, version, type, manifest, source, path, approved, checksum, installed_at) VALUES (?,?,?,?,?,?,?,?,?)", s.manifest.id, s.manifest.version, s.manifest.type, json(s.manifest), s.source, s.dir, s.approved ? 1 : 0, checksum, now());
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Does `version` satisfy a simple range: *, x.y.z, ^x.y.z, ~x.y.z, >=x.y.z */
export function satisfies(version: string, range: string): boolean {
  range = range.trim();
  if (!range || range === "*" || range === "latest") return true;
  const m = /^(\^|~|>=)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  if (!m) return false;
  const [, op, M, mi = "0", p = "0"] = m;
  const want = `${M}.${mi}.${p}`;
  const c = compareSemver(version, want);
  const [vM, vmi] = version.split(".").map(Number);
  if (op === ">=") return c >= 0;
  if (op === "^") return c >= 0 && (Number(M) > 0 ? vM === Number(M) : vmi === Number(mi));
  if (op === "~") return c >= 0 && vM === Number(M) && vmi === Number(mi);
  return c === 0 || (!m[3] && vM === Number(M)) || (!m[4] && m[3] !== undefined && vM === Number(M) && vmi === Number(mi));
}

export const getSkill = (id: string) => skills.get(id);
export const listSkills = () => [...skills.values()];

export function datasourceHandler(skillId: string): DatasourceHandler {
  const s = skills.get(skillId);
  if (!s?.server?.datasource) throw new Error(`skill '${skillId}' is not an available data source${s?.loadError ? ` (${s.loadError})` : ""}`);
  return s.server.datasource;
}

/**
 * Project-scoped skills a project can see: every built-in skill, plus the uploaded (third-party) skills assigned
 * to it (a project_skills row, written by a platform admin or by importing a package into the project).
 * An uploaded skill is never shared with other projects.
 */
export function projectSkills(projectId: string): LoadedSkill[] {
  const assigned = new Set(all<{ skill_id: string }>("SELECT skill_id FROM project_skills WHERE project_id = ?", projectId).map((r) => r.skill_id));
  return listSkills().filter((s) => s.manifest.scope === "project" && (s.source === "builtin" || assigned.has(s.manifest.id)));
}

/** Skills enabled for a project (explicit rows win over manifest defaults). System-scoped skills are excluded. */
export function enabledSkills(projectId: string): LoadedSkill[] {
  const rows = new Map(all<{ skill_id: string; enabled: number }>("SELECT skill_id, enabled FROM project_skills WHERE project_id = ?", projectId).map((r) => [r.skill_id, r.enabled === 1]));
  // a skill is enabled per project. Without an explicit setting, built-in skills follow their manifest default;
  // an uploaded (third-party) skill is only on in a project it was assigned to and enabled in
  return projectSkills(projectId).filter((s) => s.approved && (rows.has(s.manifest.id) ? rows.get(s.manifest.id)! : s.source === "builtin" && s.manifest.defaultEnabled));
}

export function projectSettings(projectId: string): Record<string, unknown> {
  return parse(get<{ settings: string }>("SELECT settings FROM projects WHERE id = ?", projectId)?.settings, {});
}

export function catalogueFor(projectId: string): Catalogue {
  const enabled = enabledSkills(projectId);
  const widgets: WidgetTypeInfo[] = [];
  const filters: FilterTypeInfo[] = [];
  const scriptLibs: ScriptLibInfo[] = [];
  const transforms: TransformInfo[] = [];
  const skillVersions: Record<string, string> = {};
  for (const s of enabled) {
    skillVersions[s.manifest.id] = s.manifest.version;
    const caps = s.manifest.capabilities as Record<string, unknown>;
    for (const w of (caps.widgets as Omit<WidgetTypeInfo, "skill">[] | undefined) ?? []) widgets.push({ ...w, skill: s.manifest.id });
    for (const f of (caps.filters as Omit<FilterTypeInfo, "skill">[] | undefined) ?? []) filters.push({ ...f, skill: s.manifest.id });
    for (const l of (caps.scriptLibs as Omit<ScriptLibInfo, "skill" | "docs">[] | undefined) ?? [])
      scriptLibs.push({ ...l, skill: s.manifest.id, docs: l.name === "@aibi/anim" ? ANIM_DOCS : "" });
    const dyn = s.server?.catalogue?.();
    if (dyn?.widgets) widgets.push(...dyn.widgets);
    if (dyn?.transforms) transforms.push(...dyn.transforms);
    if (dyn?.filters) filters.push(...dyn.filters);
    if (dyn?.scriptLibs) scriptLibs.push(...dyn.scriptLibs);
  }
  const enabledIds = new Set(enabled.map((s) => s.manifest.id));
  const sources: SourceInfo[] = all<{ alias: string; name: string; skill_id: string; description: string | null; status: string }>(
    "SELECT alias, name, skill_id, description, status FROM skill_instances WHERE project_id = ? ORDER BY alias",
    projectId,
  )
    .filter((r) => enabledIds.has(r.skill_id) && r.status !== "disabled")
    .map((r) => {
      const caps = (getSkill(r.skill_id)?.manifest.capabilities ?? {}) as { kind?: "sql" | "http"; dialect?: string };
      return { alias: r.alias, name: r.name, skill: r.skill_id, kind: caps.kind ?? "other", dialect: caps.dialect, description: r.description ?? undefined };
    });
  const settings = projectSettings(projectId);
  const moduleHosts = (settings.moduleHosts as string[] | undefined)?.length ? (settings.moduleHosts as string[]) : config.moduleHosts;
  return { widgets, transforms, filters, scriptLibs, sources, skills: skillVersions, moduleHosts };
}

/** Concatenated AI instructions from enabled skills (stable order for prompt caching). */
export function skillInstructions(projectId: string): string {
  return enabledSkills(projectId)
    .filter((s) => s.instructions)
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
    .map((s) => s.instructions)
    .join("\n\n");
}

/** Client bundles: built-in skills are bundled into the runtime; uploaded skills serve an ESM file. */
export function clientSkills(projectId: string) {
  return enabledSkills(projectId)
    .filter((s) => s.manifest.client)
    .map((s) => ({
      id: s.manifest.id,
      version: s.manifest.version,
      builtin: s.source === "builtin",
      url: s.source === "uploaded" ? `${config.publicApiUrl}/api/skills/${s.manifest.id}/client.js?v=${s.manifest.version}` : undefined,
    }));
}

export function themeTokens(projectId: string) {
  const theme = enabledSkills(projectId).find((s) => s.manifest.type === "theme") ?? getSkill("theme-default");
  return (theme?.manifest.capabilities ?? {}) as Record<string, unknown>;
}
