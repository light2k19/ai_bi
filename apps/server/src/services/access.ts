import type { FastifyRequest } from "fastify";
import { get, run, now, parse } from "../db";
import { sha256 } from "../lib/crypto";
import { forbidden, notFound, unauthorized } from "../lib/errors";

export type Role = "admin" | "builder" | "viewer";
const RANK: Record<Role, number> = { viewer: 1, builder: 2, admin: 3 };
export const roleAtLeast = (r: Role | null | undefined, min: Role) => !!r && RANK[r] >= RANK[min];

export interface User {
  id: string;
  /** what the user types to sign in: any id for form users, the Windows user id for AD users */
  login: string;
  email: string | null;
  displayName: string | null;
  isPlatformAdmin: boolean;
  /** "local" = form user with a password here; "ldap" = Active Directory user; otherwise an SSO provider id */
  authProvider: string;
}
export interface TokenAuth {
  id: string;
  projectId: string | null;
  scopes: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    pat: TokenAuth | null;
  }
}

export const SESSION_COOKIE = "aibi_session";

interface UserRow {
  id: string;
  login: string;
  email: string | null;
  display_name: string | null;
  is_platform_admin: number;
  disabled: number;
  auth_provider: string;
}
const toUser = (r: UserRow): User => ({ id: r.id, login: r.login, email: r.email, displayName: r.display_name, isPlatformAdmin: r.is_platform_admin === 1, authProvider: r.auth_provider });

/** Resolve the caller from a session cookie or a personal access token (Authorization: Bearer aibi_pat_...). */
export function authenticate(req: FastifyRequest) {
  req.user = null;
  req.pat = null;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer aibi_pat_")) {
    const tok = auth.slice(7).trim();
    const row = get<{ id: string; user_id: string; project_id: string | null; scopes: string; expires_at: string | null; revoked: number }>(
      "SELECT id, user_id, project_id, scopes, expires_at, revoked FROM api_tokens WHERE token_hash = ?",
      sha256(tok),
    );
    if (!row || row.revoked || (row.expires_at && row.expires_at < now())) return;
    const u = get<UserRow>("SELECT * FROM users WHERE id = ?", row.user_id);
    if (!u || u.disabled) return;
    req.user = toUser(u);
    req.pat = { id: row.id, projectId: row.project_id, scopes: parse<string[]>(row.scopes, []) };
    run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", now(), row.id);
    return;
  }
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return;
  const s = get<{ user_id: string; expires_at: string }>("SELECT user_id, expires_at FROM sessions WHERE id = ?", sha256(sid));
  if (!s || s.expires_at < now()) return;
  const u = get<UserRow>("SELECT * FROM users WHERE id = ?", s.user_id);
  if (!u || u.disabled) return;
  req.user = toUser(u);
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** Personal access tokens may only use routes whose scope they carry. Sessions have every scope. */
export function requireScope(req: FastifyRequest, scope: string) {
  if (req.pat && !req.pat.scopes.includes(scope)) throw forbidden(`this token lacks the '${scope}' scope`);
}

export function requirePlatformAdmin(req: FastifyRequest): User {
  const u = requireUser(req);
  if (req.pat) throw forbidden("platform administration is not available to access tokens");
  if (!u.isPlatformAdmin) throw forbidden("platform administrators only");
  return u;
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  settings: string;
  created_by: string | null;
  created_at: string;
  archived: number;
}

export function findProject(idOrSlug: string): ProjectRow | undefined {
  return get<ProjectRow>("SELECT * FROM projects WHERE (id = ? OR slug = ?) AND archived = 0", idOrSlug, idOrSlug);
}

/** The caller's role in a project; a disabled membership gives none (platform admins always have admin). */
export function memberRole(projectId: string, user: User): Role | null {
  if (user.isPlatformAdmin) return "admin";
  const r = get<{ role: Role; enabled: number }>("SELECT role, enabled FROM project_members WHERE project_id = ? AND user_id = ?", projectId, user.id);
  return r && r.enabled !== 0 ? r.role : null;
}

/** Load a project the caller can access with at least `min` role. */
export function requireProject(req: FastifyRequest, idOrSlug: string, min: Role = "viewer"): { project: ProjectRow; role: Role; user: User } {
  const user = requireUser(req);
  const project = findProject(idOrSlug);
  if (!project) throw notFound("Project not found");
  if (req.pat?.projectId && req.pat.projectId !== project.id) throw forbidden("this token is limited to another project");
  const role = memberRole(project.id, user);
  if (!role) throw notFound("Project not found");
  if (!roleAtLeast(role, min)) throw forbidden(`requires the ${min} role in this project`);
  return { project, role, user };
}
