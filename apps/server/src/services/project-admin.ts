/**
 * Project lifecycle: archive (reversible), restore, rename, and permanent deletion.
 * Permanent deletion removes the project row (members, skills, data sources with their schemas, pages
 * with versions, modules links, packages, imports, AI sessions and project tokens cascade), the
 * project's query log and AI usage rows, and the package/import files on disk. The audit log keeps its
 * rows, plus a final "project.delete" entry, so deletions stay traceable.
 */
import fs from "node:fs";
import path from "node:path";
import { all, get, run, tx } from "../db";
import { config } from "../config";
import { badRequest, conflict, notFound } from "../lib/errors";
import { datasourceHandler } from "../skills/registry";
import { invalidateInstanceCache } from "./gateway";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export interface ProjectRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  archived: number;
  created_at: string;
}

/** Find a project by id or slug, including archived ones (platform administration only). */
export function findAnyProject(idOrSlug: string): ProjectRecord {
  const p = get<ProjectRecord>("SELECT id, slug, name, description, archived, created_at FROM projects WHERE id = ? OR slug = ?", idOrSlug, idOrSlug);
  if (!p) throw notFound("Project not found");
  return p;
}

export function archivedProjects() {
  return all<ProjectRecord & { pages: number; sources: number; members: number }>(
    `SELECT p.id, p.slug, p.name, p.description, p.archived, p.created_at,
       (SELECT COUNT(*) FROM pages WHERE project_id = p.id AND deleted = 0) AS pages,
       (SELECT COUNT(*) FROM skill_instances WHERE project_id = p.id) AS sources,
       (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) AS members
     FROM projects p WHERE p.archived = 1 ORDER BY p.name`,
  );
}

/** Validate and apply a slug change. Old URLs stop working; ids (tokens, packages) are unaffected. */
export function changeSlug(projectId: string, slug: string) {
  if (!SLUG_RE.test(slug)) throw badRequest("Slug: 2–41 lower-case letters, digits and dashes, starting with a letter or digit");
  if (get("SELECT 1 FROM projects WHERE slug = ? AND id <> ?", slug, projectId)) throw conflict("That slug is taken");
  run("UPDATE projects SET slug = ? WHERE id = ?", slug, projectId);
}

/** Files under the data directory that belong to the project (packages and import uploads). */
function projectFiles(projectId: string): string[] {
  const rows = all<{ storage_path: string }>(
    "SELECT storage_path FROM packages WHERE project_id = ? UNION SELECT storage_path FROM imports WHERE project_id = ?",
    projectId,
    projectId,
  );
  const root = path.resolve(config.dataDir) + path.sep;
  // never touch anything outside the data directory, and keep files another project still references
  return rows
    .map((r) => path.resolve(r.storage_path))
    .filter((f) => f.startsWith(root))
    .filter((f) => !get("SELECT 1 FROM packages WHERE storage_path = ? AND project_id <> ? UNION SELECT 1 FROM imports WHERE storage_path = ? AND project_id <> ?", f, projectId, f, projectId));
}

export async function deleteProjectPermanently(projectId: string) {
  const instances = all<{ id: string; skill_id: string }>("SELECT id, skill_id FROM skill_instances WHERE project_id = ?", projectId);
  for (const i of instances) {
    try {
      await datasourceHandler(i.skill_id).close?.(i.id);
    } catch {
      /* the skill may be gone or disabled */
    }
    invalidateInstanceCache(i.id);
  }
  const files = projectFiles(projectId);
  const counts = {
    pages: get<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE project_id = ?", projectId)!.n,
    sources: instances.length,
    members: get<{ n: number }>("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?", projectId)!.n,
    files: 0,
  };
  tx(() => {
    run("DELETE FROM query_log WHERE project_id = ?", projectId);
    run("DELETE FROM ai_usage WHERE project_id = ?", projectId);
    run("DELETE FROM projects WHERE id = ?", projectId);
  });
  for (const f of files) {
    try {
      fs.rmSync(f, { force: true });
      counts.files++;
    } catch {
      /* already gone */
    }
  }
  return counts;
}
