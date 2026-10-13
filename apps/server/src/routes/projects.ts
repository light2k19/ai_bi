import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { strFromU8 } from "fflate";
import { unzipBounded } from "../services/packages";
import { SkillManifest } from "@aibi/skill-sdk";
import { config } from "../config";
import { all, get, run, now, json, parse, tx } from "../db";
import { newId, hashPassword, sealSecrets, maskSecrets, openSecrets } from "../lib/crypto";
import { badRequest, conflict, notFound, forbidden } from "../lib/errors";
import { requireProject, requirePlatformAdmin, requireUser, requireScope, roleAtLeast } from "../services/access";
import { audit } from "../services/audit";
import { catalogueFor, clientSkills, listSkills, getSkill, loadSkills, themeTokens, enabledSkills, projectSkills } from "../skills/registry";
import { systemSkillSettings } from "./auth";
import { aiStatusFor } from "../ai/status";
import { archivedProjects, changeSlug, deleteProjectPermanently, findAnyProject } from "../services/project-admin";
import { analyzeProjectImport, commitProjectImport, exportProject, getProjectImport } from "../services/project-packages";

const ROLE = z.enum(["admin", "builder", "viewer"]);

/**
 * Find or create the account of an Active Directory user from the Windows user id alone: email and name come
 * from the directory through the service account, the password stays there.
 */
async function ensureAdUser(typedLogin: string, name?: string): Promise<{ id: string; login: string }> {
  const s = getSkill("auth-ldap");
  const st = systemSkillSettings("auth-ldap");
  if (!s?.server?.auth?.lookup || !st.enabled) throw badRequest("Active Directory sign-in is not enabled (Platform admin → Sign-in)");
  const login = typedLogin.replace(/@.*$/, "").toLowerCase();
  const known = get<{ id: string }>("SELECT id FROM users WHERE auth_provider = 'ldap' AND login = ? COLLATE NOCASE", login);
  if (known) return { id: known.id, login };
  const ident = await s.server.auth.lookup(st.settings, typedLogin).catch((e: Error) => {
    throw badRequest(`Active Directory lookup failed: ${e.message}`);
  });
  if (!ident) throw badRequest(`No Active Directory user '${typedLogin}' was found`);
  const existing = get<{ id: string; auth_provider: string }>("SELECT id, auth_provider FROM users WHERE login = ? COLLATE NOCASE OR (email IS NOT NULL AND email = ?)", ident.externalId, ident.email);
  if (existing) {
    if (existing.auth_provider !== "ldap") throw conflict(`${ident.email ?? ident.externalId} already exists as a ${existing.auth_provider === "local" ? "form" : existing.auth_provider} user`);
    return { id: existing.id, login: ident.externalId };
  }
  const id = newId("usr");
  run("INSERT INTO users (id, login, email, display_name, auth_provider, external_id, created_at) VALUES (?,?,?,?,?,?,?)", id, ident.externalId, ident.email, name || ident.displayName || null, "ldap", ident.externalId, now());
  return { id, login: ident.externalId };
}

/** Set a form user's password on their behalf and sign them out everywhere. AD and SSO users have no password here. */
function setPasswordFor(userId: string, password: string, actorId: string, projectId: string | null) {
  const u = get<{ id: string; auth_provider: string }>("SELECT id, auth_provider FROM users WHERE id = ?", userId);
  if (!u) throw notFound("User not found");
  if (u.auth_provider !== "local") throw badRequest(u.auth_provider === "ldap" ? "This is an Active Directory user; the password is managed by the directory" : "This user signs in with single sign-on and has no password here");
  run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), u.id);
  run("DELETE FROM sessions WHERE user_id = ?", u.id);
  audit(projectId, actorId, "user.password.reset", u.id);
}

function publicSkill(s: ReturnType<typeof listSkills>[number]) {
  return {
    id: s.manifest.id,
    version: s.manifest.version,
    type: s.manifest.type,
    name: s.manifest.name,
    description: s.manifest.description,
    scope: s.manifest.scope,
    source: s.source,
    approved: s.approved,
    defaultEnabled: s.manifest.defaultEnabled,
    multiInstance: s.manifest.multiInstance,
    configSchema: s.manifest.configSchema,
    secrets: s.manifest.secrets,
    userCredentials: s.manifest.userCredentials,
    capabilities: s.manifest.capabilities,
    tools: s.manifest.tools.map((t) => t.name),
    permissions: s.manifest.permissions,
    loadError: s.loadError,
  };
}

export async function projectRoutes(app: FastifyInstance) {
  /* ───────── projects ───────── */
  app.get("/projects", async (req) => {
    const u = requireUser(req);
    const { userProjects } = await import("./auth");
    return userProjects(u.id, u.isPlatformAdmin);
  });

  app.post("/projects", async (req) => {
    const u = requirePlatformAdmin(req);
    const body = z.object({ name: z.string().min(1).max(100), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/), description: z.string().optional() }).parse(req.body);
    if (get("SELECT 1 FROM projects WHERE slug = ?", body.slug)) throw conflict("That slug is taken");
    const id = newId("prj");
    tx(() => {
      run("INSERT INTO projects (id, slug, name, description, settings, created_by, created_at) VALUES (?,?,?,?,?,?,?)", id, body.slug, body.name, body.description ?? null, "{}", u.id, now());
      run("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?,?,?,?)", id, u.id, "admin", now());
    });
    audit(id, u.id, "project.create", id, body);
    return { id, slug: body.slug };
  });

  app.get<{ Params: { p: string } }>("/projects/:p", async (req) => {
    const { project, role } = requireProject(req, req.params.p);
    const settings = parse<Record<string, unknown>>(project.settings, {});
    return { id: project.id, slug: project.slug, name: project.name, description: project.description, role, settings: roleAtLeast(role, "admin") ? settings : { theme: settings.theme }, ai: await aiStatusFor(project.id) };
  });

  app.patch<{ Params: { p: string } }>("/projects/:p", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        slug: z.string().optional(),
        description: z.string().nullable().optional(),
        settings: z
          .object({
            limits: z.object({ maxRows: z.number().int().positive().optional(), timeoutMs: z.number().int().positive().optional(), maxBytes: z.number().int().positive().optional() }).optional(),
            ai: z
              .object({
                enabled: z.boolean().optional(),
                model: z.string().optional(),
                fastModel: z.string().optional(),
                toolMode: z.enum(["native", "json"]).optional(),
                monthlyTokenBudget: z.number().int().nonnegative().optional(),
                monthlyCostBudget: z.number().nonnegative().optional(),
                viewerQueries: z.boolean().optional(),
              })
              .optional(),
            moduleHosts: z.array(z.string()).optional(),
            moduleApproval: z.boolean().optional(),
            embedHosts: z.array(z.string()).optional(),
            theme: z.record(z.unknown()).optional(),
          })
          .optional(),
      })
      .parse(req.body);
    const settings = { ...parse<Record<string, unknown>>(project.settings, {}), ...(body.settings ?? {}) };
    tx(() => {
      if (body.slug !== undefined && body.slug !== project.slug) changeSlug(project.id, body.slug);
      run("UPDATE projects SET name = ?, description = ?, settings = ? WHERE id = ?", body.name ?? project.name, body.description === undefined ? project.description : body.description, json(settings), project.id);
    });
    audit(project.id, user.id, "project.update", project.id, body.slug !== undefined && body.slug !== project.slug ? { ...body, previousSlug: project.slug } : body);
    return { ok: true, slug: body.slug ?? project.slug };
  });

  app.delete<{ Params: { p: string } }>("/projects/:p", async (req) => {
    const u = requirePlatformAdmin(req);
    const { project } = requireProject(req, req.params.p, "admin");
    run("UPDATE projects SET archived = 1 WHERE id = ?", project.id);
    audit(project.id, u.id, "project.archive", project.id);
    return { ok: true, archived: true };
  });

  /* archived projects (platform admins): list, restore, delete permanently */
  app.get("/projects/archived", async (req) => {
    requirePlatformAdmin(req);
    return archivedProjects().map((p) => ({ id: p.id, slug: p.slug, name: p.name, description: p.description, createdAt: p.created_at, pages: p.pages, sources: p.sources, members: p.members }));
  });

  app.post<{ Params: { p: string } }>("/projects/:p/restore", async (req) => {
    const u = requirePlatformAdmin(req);
    const p = findAnyProject(req.params.p);
    if (!p.archived) throw badRequest("This project is not archived");
    run("UPDATE projects SET archived = 0 WHERE id = ?", p.id);
    audit(p.id, u.id, "project.restore", p.id);
    return { ok: true, slug: p.slug };
  });

  app.post<{ Params: { p: string } }>("/projects/:p/delete", async (req) => {
    const u = requirePlatformAdmin(req);
    const p = findAnyProject(req.params.p);
    const body = z.object({ confirm: z.string() }).parse(req.body ?? {});
    if (body.confirm !== p.slug) throw badRequest(`Type the project slug '${p.slug}' to confirm permanent deletion`);
    const counts = await deleteProjectPermanently(p.id);
    audit(p.id, u.id, "project.delete", p.id, { slug: p.slug, name: p.name, ...counts });
    return { ok: true, ...counts };
  });

  /* ───────── project packages ───────── */
  app.get<{ Params: { p: string }; Querystring: { vendor?: string } }>("/projects/:p/export", async (req, reply) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    const pkg = exportProject(project.id, user, { vendorModules: req.query.vendor !== "0" });
    reply.header("Content-Disposition", `attachment; filename="${pkg.filename}"`).type("application/zip");
    return reply.send(pkg.buffer);
  });

  app.post("/project-imports/analyze", async (req) => {
    const user = requirePlatformAdmin(req);
    const file = await req.file();
    if (!file) throw badRequest("Attach a project package (.aibi)");
    return analyzeProjectImport(user, await file.toBuffer(), file.filename);
  });

  app.get<{ Params: { id: string } }>("/project-imports/:id", async (req) => {
    const user = requirePlatformAdmin(req);
    return getProjectImport(req.params.id, user);
  });

  app.post<{ Params: { id: string } }>("/project-imports/:id/commit", async (req) => {
    const user = requirePlatformAdmin(req);
    const body = z.object({ mode: z.enum(["new", "overwrite"]), slug: z.string().optional(), name: z.string().optional(), overwrite: z.boolean().optional(), credentials: z.record(z.record(z.unknown())).optional() }).parse(req.body);
    return commitProjectImport(user, req.params.id, body);
  });

  /* ───────── members ───────── */
  app.get<{ Params: { p: string } }>("/projects/:p/members", async (req) => {
    const { project } = requireProject(req, req.params.p);
    return all<{ user_id: string; role: string; enabled: number; login: string; email: string | null; display_name: string | null; auth_provider: string; platform_disabled: number; added_at: string; last_login_at: string | null }>(
      "SELECT m.user_id, m.role, m.enabled, u.login, u.email, u.display_name, u.auth_provider, u.disabled AS platform_disabled, m.added_at, u.last_login_at FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.login",
      project.id,
    ).map((m) => ({ userId: m.user_id, role: m.role, enabled: m.enabled !== 0, platformDisabled: m.platform_disabled === 1, login: m.login, email: m.email, name: m.display_name, kind: m.auth_provider === "ldap" ? "ad" : m.auth_provider === "local" ? "form" : "sso", addedAt: m.added_at, lastLoginAt: m.last_login_at }));
  });

  app.post<{ Params: { p: string } }>("/projects/:p/members", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    const body = z
      .object({
        kind: z.enum(["form", "ad"]).default("form"),
        email: z.string().trim().email().optional(),
        /** form users: any login id (defaults to the email); AD users: the Windows user id */
        login: z.string().trim().min(2).max(200).regex(/^\S+$/, "the login id cannot contain spaces").optional(),
        role: ROLE,
        name: z.string().optional(),
        password: z.string().min(8).optional(),
      })
      .parse(req.body);
    let u: { id: string } | undefined;
    let login = body.login ?? body.email ?? "";
    if (body.kind === "ad") {
      if (!body.login) throw badRequest("Enter the Windows user id");
      const ad = await ensureAdUser(body.login, body.name);
      u = { id: ad.id };
      login = ad.login;
    } else {
      if (!login) throw badRequest("Enter the login id");
      const found = get<{ id: string; auth_provider: string; login: string }>("SELECT id, auth_provider, login FROM users WHERE login = ? COLLATE NOCASE OR (email IS NOT NULL AND email = ?)", login, body.email ?? login);
      // the id is taken by a user of another kind: never silently reused
      if (found && found.auth_provider !== "local") throw conflict(`'${found.login}' is already ${found.auth_provider === "ldap" ? "an Active Directory user" : "a single sign-on user"}; choose another login id or add them as that kind`, { code: "login_taken", kind: found.auth_provider === "ldap" ? "ad" : "sso" });
      u = found ?? undefined;
      if (!u) {
        // a new form user needs a password to sign in with; AD users never have one here
        if (!body.password) throw badRequest("Set an initial password for the new user");
        const id = newId("usr");
        run("INSERT INTO users (id, login, email, display_name, password_hash, auth_provider, created_at) VALUES (?,?,?,?,?,?,?)", id, login, body.email ?? null, body.name ?? null, body.password ? hashPassword(body.password) : null, "local", now());
        u = { id };
      }
    }
    if (get("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?", project.id, u.id)) run("UPDATE project_members SET role = ?, enabled = 1 WHERE project_id = ? AND user_id = ?", body.role, project.id, u.id);
    else run("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?,?,?,?)", project.id, u.id, body.role, now());
    audit(project.id, user.id, "member.add", u.id, { login, role: body.role, kind: body.kind });
    return { ok: true, userId: u.id, login, email: get<{ email: string | null }>("SELECT email FROM users WHERE id = ?", u.id)!.email };
  });

  app.patch<{ Params: { p: string; userId: string } }>("/projects/:p/members/:userId", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    const body = z.object({ role: ROLE.optional(), enabled: z.boolean().optional(), name: z.string().trim().min(1).max(100).optional() }).parse(req.body);
    const target = get<{ role: string; enabled: number }>("SELECT role, enabled FROM project_members WHERE project_id = ? AND user_id = ?", project.id, req.params.userId);
    if (!target) throw notFound("Member not found");
    if (body.name !== undefined) {
      // a member's display name (platform admins' names only by a platform admin)
      if (get<{ a: number }>("SELECT is_platform_admin AS a FROM users WHERE id = ?", req.params.userId)?.a === 1 && !user.isPlatformAdmin) throw forbidden("Only a platform admin can rename a platform admin");
      run("UPDATE users SET display_name = ? WHERE id = ?", body.name, req.params.userId);
      audit(project.id, user.id, "member.rename", req.params.userId, { name: body.name });
    }
    // the project must keep one enabled admin: counted after the change
    const role = body.role ?? target.role;
    const enabled = body.enabled ?? target.enabled !== 0;
    if (target.role === "admin" && target.enabled !== 0 && (role !== "admin" || !enabled)) {
      const admins = get<{ n: number }>("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'admin' AND enabled = 1", project.id)!.n;
      if (admins <= 1) throw badRequest("A project needs at least one enabled admin");
    }
    if (req.params.userId === user.id && !enabled) throw badRequest("You cannot disable yourself");
    run("UPDATE project_members SET role = ?, enabled = ? WHERE project_id = ? AND user_id = ?", role, enabled ? 1 : 0, project.id, req.params.userId);
    if (body.role !== undefined && body.role !== target.role) audit(project.id, user.id, "member.role", req.params.userId, { role: body.role });
    if (body.enabled !== undefined && body.enabled !== (target.enabled !== 0)) audit(project.id, user.id, body.enabled ? "member.enable" : "member.disable", req.params.userId);
    return { ok: true };
  });

  app.post<{ Params: { p: string; userId: string } }>("/projects/:p/members/:userId/password", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    const body = z.object({ password: z.string().min(8) }).parse(req.body);
    if (!get("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?", project.id, req.params.userId)) throw notFound("Member not found");
    if (get<{ a: number }>("SELECT is_platform_admin AS a FROM users WHERE id = ?", req.params.userId)?.a === 1 && !user.isPlatformAdmin) throw forbidden("Only a platform admin can change a platform admin's password");
    setPasswordFor(req.params.userId, body.password, user.id, project.id);
    return { ok: true };
  });

  app.delete<{ Params: { p: string; userId: string } }>("/projects/:p/members/:userId", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    const target = get<{ role: string }>("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?", project.id, req.params.userId);
    if (target?.role === "admin" && get<{ n: number }>("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'admin' AND enabled = 1", project.id)!.n <= 1) throw badRequest("A project needs at least one enabled admin");
    run("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", project.id, req.params.userId);
    // pages owned by the removed member move to the acting admin
    run("UPDATE pages SET owner_id = ? WHERE project_id = ? AND owner_id = ?", user.id, project.id, req.params.userId);
    // a removed member's data source logins go with them
    run("DELETE FROM user_source_credentials WHERE user_id = ? AND instance_id IN (SELECT id FROM skill_instances WHERE project_id = ?)", req.params.userId, project.id);
    audit(project.id, user.id, "member.remove", req.params.userId);
    return { ok: true };
  });

  /* ───────── catalogue & runtime config ───────── */
  app.get<{ Params: { p: string } }>("/projects/:p/catalogue", async (req) => {
    const { project } = requireProject(req, req.params.p);
    return catalogueFor(project.id);
  });

  app.get<{ Params: { p: string } }>("/projects/:p/runtime-config", async (req) => {
    requireScope(req, "page:read");
    const { project } = requireProject(req, req.params.p);
    const settings = parse<Record<string, unknown>>(project.settings, {});
    return {
      catalogue: catalogueFor(project.id),
      clientSkills: clientSkills(project.id),
      theme: { ...themeTokens(project.id), ...((settings.theme as object) ?? {}) },
      embedHosts: (settings.embedHosts as string[] | undefined) ?? [],
      runtimeOrigin: config.runtimeOrigin,
      apiUrl: config.publicApiUrl,
    };
  });

  /* ───────── skills ───────── */
  app.get("/skills", async (req) => {
    const u = requireUser(req);
    return listSkills().map((s) => ({
      ...publicSkill(s),
      // third-party skills belong to the projects they are assigned to; platform admins see and change that
      projects: s.source !== "builtin" && u.isPlatformAdmin ? all<{ id: string; slug: string; name: string }>("SELECT p.id, p.slug, p.name FROM project_skills ps JOIN projects p ON p.id = ps.project_id WHERE ps.skill_id = ? AND p.archived = 0 ORDER BY p.name", s.manifest.id) : undefined,
    }));
  });

  /* which projects may use an uploaded skill: assigned projects list it in their Skills tab and may enable it */
  app.put<{ Params: { id: string } }>("/skills/:id/projects", async (req) => {
    const u = requirePlatformAdmin(req);
    const s = getSkill(req.params.id);
    if (!s || s.manifest.scope !== "project" || s.source === "builtin") throw notFound("Third-party skill not found");
    const body = z.object({ projectIds: z.array(z.string()) }).parse(req.body);
    const want = new Set(body.projectIds);
    tx(() => {
      for (const r of all<{ project_id: string }>("SELECT project_id FROM project_skills WHERE skill_id = ?", s.manifest.id)) if (!want.has(r.project_id)) run("DELETE FROM project_skills WHERE project_id = ? AND skill_id = ?", r.project_id, s.manifest.id);
      for (const id of want) {
        if (!get("SELECT 1 FROM projects WHERE id = ?", id)) throw notFound(`Project ${id} not found`);
        if (!get("SELECT 1 FROM project_skills WHERE project_id = ? AND skill_id = ?", id, s.manifest.id)) run("INSERT INTO project_skills (project_id, skill_id, enabled, settings) VALUES (?,?,1,'{}')", id, s.manifest.id);
      }
    });
    audit(null, u.id, "skill.assign", s.manifest.id, { projects: [...want] });
    return { ok: true };
  });

  app.get<{ Params: { p: string } }>("/projects/:p/skills", async (req) => {
    const { project } = requireProject(req, req.params.p);
    const rows = new Map(all<{ skill_id: string; enabled: number; settings: string }>("SELECT * FROM project_skills WHERE project_id = ?", project.id).map((r) => [r.skill_id, r]));
    const enabled = new Set(enabledSkills(project.id).map((s) => s.manifest.id));
    return projectSkills(project.id)
      .map((s) => ({ ...publicSkill(s), enabled: enabled.has(s.manifest.id), settings: parse(rows.get(s.manifest.id)?.settings, {}), instances: all<{ name: string; alias: string; status: string; description: string | null }>("SELECT name, alias, status, description FROM skill_instances WHERE project_id = ? AND skill_id = ? ORDER BY alias", project.id, s.manifest.id) }));
  });

  app.put<{ Params: { p: string; id: string } }>("/projects/:p/skills/:id", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    const s = getSkill(req.params.id);
    if (!s || s.manifest.scope !== "project") throw notFound("Skill not found");
    if (!s.approved) throw forbidden("This skill is waiting for platform approval");
    if (s.source !== "builtin" && !get("SELECT 1 FROM project_skills WHERE project_id = ? AND skill_id = ?", project.id, s.manifest.id)) throw notFound("This skill is not assigned to the project; a platform admin assigns third-party skills to projects");
    const body = z.object({ enabled: z.boolean(), settings: z.record(z.unknown()).optional() }).parse(req.body);
    const missing = Object.keys(s.manifest.dependencies.skills).filter((dep) => body.enabled && !enabledSkills(project.id).some((x) => x.manifest.id === dep) && dep !== s.manifest.id);
    if (missing.length) throw badRequest(`Enable required skills first: ${missing.join(", ")}`);
    if (get("SELECT 1 FROM project_skills WHERE project_id = ? AND skill_id = ?", project.id, s.manifest.id)) run("UPDATE project_skills SET enabled = ?, settings = COALESCE(?, settings) WHERE project_id = ? AND skill_id = ?", body.enabled ? 1 : 0, body.settings ? json(body.settings) : null, project.id, s.manifest.id);
    else run("INSERT INTO project_skills (project_id, skill_id, enabled, settings) VALUES (?,?,?,?)", project.id, s.manifest.id, body.enabled ? 1 : 0, json(body.settings ?? {}));
    audit(project.id, user.id, body.enabled ? "skill.enable" : "skill.disable", s.manifest.id);
    return { ok: true };
  });

  /* system skills (auth) */
  app.get<{ Params: { id: string } }>("/system-skills/:id", async (req) => {
    requirePlatformAdmin(req);
    const s = getSkill(req.params.id);
    if (!s || s.manifest.scope !== "system") throw notFound("Skill not found");
    const st = systemSkillSettings(s.manifest.id);
    return { ...publicSkill(s), enabled: st.enabled, settings: maskSecrets(st.settings, s.manifest.secrets) };
  });

  app.put<{ Params: { id: string } }>("/system-skills/:id", async (req) => {
    const u = requirePlatformAdmin(req);
    const s = getSkill(req.params.id);
    if (!s || s.manifest.scope !== "system") throw notFound("Skill not found");
    const body = z.object({ enabled: z.boolean(), settings: z.record(z.unknown()).default({}) }).parse(req.body);
    const prev = parse<Record<string, unknown>>(get<{ settings: string }>("SELECT settings FROM system_skill_settings WHERE skill_id = ?", s.manifest.id)?.settings, {});
    if (s.manifest.id === "auth-local" && !body.enabled && !get("SELECT 1 FROM system_skill_settings WHERE skill_id IN ('auth-oidc', 'auth-ldap') AND enabled = 1")) {
      throw badRequest("Enable single sign-on or Active Directory before disabling password sign-in");
    }
    const sealed = sealSecrets(body.settings, s.manifest.secrets, prev);
    if (get("SELECT 1 FROM system_skill_settings WHERE skill_id = ?", s.manifest.id)) run("UPDATE system_skill_settings SET enabled = ?, settings = ? WHERE skill_id = ?", body.enabled ? 1 : 0, json(sealed), s.manifest.id);
    else run("INSERT INTO system_skill_settings (skill_id, enabled, settings) VALUES (?,?,?)", s.manifest.id, body.enabled ? 1 : 0, json(sealed));
    audit(null, u.id, "system-skill.update", s.manifest.id, { enabled: body.enabled });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/system-skills/:id/test", async (req) => {
    requirePlatformAdmin(req);
    const s = getSkill(req.params.id);
    if (!s || s.manifest.scope !== "system" || !s.server?.auth?.test) throw notFound("This skill has no connection test");
    const body = z.object({ settings: z.record(z.unknown()).default({}) }).parse(req.body);
    const prev = parse<Record<string, unknown>>(get<{ settings: string }>("SELECT settings FROM system_skill_settings WHERE skill_id = ?", s.manifest.id)?.settings, {});
    const settings = openSecrets(sealSecrets(body.settings, s.manifest.secrets, prev), s.manifest.secrets);
    try {
      return await s.server.auth.test(settings);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });

  /* upload a third-party skill (zip with skill.json at the root); runs only after approval */
  app.post("/skills/upload", async (req) => {
    const u = requirePlatformAdmin(req);
    const file = await req.file();
    if (!file) throw badRequest("Attach a .zip file");
    const buf = await file.toBuffer();
    const entries = unzipBounded(buf);
    const root = Object.keys(entries).find((k) => k.endsWith("skill.json"))?.replace(/skill\.json$/, "") ?? "";
    const mtext = entries[`${root}skill.json`];
    if (!mtext) throw badRequest("The zip has no skill.json");
    const manifest = SkillManifest.parse(JSON.parse(strFromU8(mtext)));
    const dir = path.join(config.uploadedSkillsDir, `${manifest.id}@${manifest.version}`);
    if (fs.existsSync(dir)) throw conflict(`${manifest.id}@${manifest.version} is already installed`);
    for (const [p, data] of Object.entries(entries)) {
      if (!p.startsWith(root) || p.endsWith("/")) continue;
      const rel = path.normalize(p.slice(root.length));
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw badRequest(`unsafe path ${p}`);
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), data);
    }
    run("INSERT OR REPLACE INTO skills (id, version, type, manifest, source, path, approved, checksum, installed_at) VALUES (?,?,?,?,?,?,?,?,?)", manifest.id, manifest.version, manifest.type, json(manifest), "uploaded", dir, 0, null, now());
    audit(null, u.id, "skill.upload", `${manifest.id}@${manifest.version}`, { permissions: manifest.permissions });
    await loadSkills();
    return { ok: true, id: manifest.id, version: manifest.version, approved: false, permissions: manifest.permissions };
  });

  app.post<{ Params: { id: string } }>("/skills/:id/approve", async (req) => {
    const u = requirePlatformAdmin(req);
    const body = z.object({ version: z.string(), approved: z.boolean() }).parse(req.body);
    run("UPDATE skills SET approved = ? WHERE id = ? AND version = ?", body.approved ? 1 : 0, req.params.id, body.version);
    audit(null, u.id, body.approved ? "skill.approve" : "skill.revoke", `${req.params.id}@${body.version}`);
    await loadSkills();
    return { ok: true };
  });

  /* client bundle of an uploaded skill (ESM). Built-in skills are bundled into the runtime. */
  app.get<{ Params: { id: string } }>("/skills/:id/client.js", async (req, reply) => {
    const s = getSkill(req.params.id);
    if (!s || s.source !== "uploaded" || !s.approved || !s.manifest.client) throw notFound();
    const f = path.join(s.dir, s.manifest.client.replace(/\.tsx?$/, ".js"));
    if (!fs.existsSync(f)) throw notFound("The skill has no built client bundle");
    reply.header("Access-Control-Allow-Origin", "*").header("Cache-Control", "public, max-age=300").type("text/javascript");
    return fs.readFileSync(f, "utf8");
  });

  /* is a login id free? Used by the add-user dialogs while typing; project and platform admins only */
  app.get<{ Querystring: { login?: string } }>("/users/check", async (req) => {
    const u = requireUser(req);
    if (!u.isPlatformAdmin && !get("SELECT 1 FROM project_members WHERE user_id = ? AND role = 'admin' AND enabled = 1", u.id)) throw forbidden("Admins only");
    const login = (req.query.login ?? "").trim().replace(/@.*$/, "");
    if (login.length < 2) return { exists: false };
    const row = get<{ auth_provider: string; login: string; display_name: string | null }>("SELECT auth_provider, login, display_name FROM users WHERE login = ? COLLATE NOCASE OR (email IS NOT NULL AND email = ?)", login, req.query.login?.trim() ?? login);
    return row ? { exists: true, login: row.login, name: row.display_name, kind: row.auth_provider === "ldap" ? "ad" : row.auth_provider === "local" ? "form" : "sso" } : { exists: false };
  });

  /* ───────── platform users ───────── */
  app.get("/users", async (req) => {
    requirePlatformAdmin(req);
    return all<{ id: string; login: string; email: string | null; display_name: string | null; auth_provider: string; is_platform_admin: number; disabled: number; created_at: string; last_login_at: string | null }>("SELECT * FROM users ORDER BY login").map((u) => ({
      id: u.id,
      login: u.login,
      email: u.email,
      name: u.display_name,
      provider: u.auth_provider,
      isPlatformAdmin: u.is_platform_admin === 1,
      disabled: u.disabled === 1,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
    }));
  });

  app.post("/users", async (req) => {
    const admin = requirePlatformAdmin(req);
    const body = z.object({ kind: z.enum(["form", "ad"]).default("form"), login: z.string().trim().min(2).max(100).regex(/^\S+$/).optional(), email: z.string().trim().email().optional(), name: z.string().optional(), password: z.string().min(8).optional(), isPlatformAdmin: z.boolean().default(false) }).parse(req.body);
    if (body.kind === "ad") {
      if (!body.login) throw badRequest("Enter the Windows user id");
      const ad = await ensureAdUser(body.login, body.name);
      if (body.isPlatformAdmin) run("UPDATE users SET is_platform_admin = 1 WHERE id = ?", ad.id);
      audit(null, admin.id, "user.create", ad.id, { login: ad.login, kind: "ad", isPlatformAdmin: body.isPlatformAdmin });
      return { id: ad.id };
    }
    const login = body.login ?? body.email;
    if (!login) throw badRequest("Enter a login id");
    if (!body.password) throw badRequest("A form user needs a password");
    if (get("SELECT 1 FROM users WHERE login = ? COLLATE NOCASE OR (email IS NOT NULL AND email = ?)", login, body.email ?? login)) throw conflict("A user with this login id or email exists");
    const id = newId("usr");
    run("INSERT INTO users (id, login, email, display_name, password_hash, auth_provider, is_platform_admin, created_at) VALUES (?,?,?,?,?,?,?,?)", id, login, body.email ?? null, body.name ?? null, body.password ? hashPassword(body.password) : null, "local", body.isPlatformAdmin ? 1 : 0, now());
    audit(null, admin.id, "user.create", id, { login, email: body.email, kind: "form" });
    return { id };
  });

  /* what disabling or removing this account touches: every project membership and the pages they own */
  app.get<{ Params: { id: string } }>("/users/:id/projects", async (req) => {
    requirePlatformAdmin(req);
    if (!get("SELECT 1 FROM users WHERE id = ?", req.params.id)) throw notFound("User not found");
    return {
      projects: all<{ id: string; slug: string; name: string; role: string; enabled: number; pages: number }>(
        `SELECT p.id, p.slug, p.name, m.role, m.enabled, (SELECT COUNT(*) FROM pages pg WHERE pg.project_id = p.id AND pg.owner_id = m.user_id AND pg.deleted = 0) AS pages
         FROM project_members m JOIN projects p ON p.id = m.project_id WHERE m.user_id = ? AND p.archived = 0 ORDER BY p.name`,
        req.params.id,
      ).map((p) => ({ id: p.id, slug: p.slug, name: p.name, role: p.role, enabled: p.enabled !== 0, pages: p.pages })),
      tokens: get<{ n: number }>("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked = 0", req.params.id)!.n,
    };
  });

  /* remove the account everywhere: memberships, logins, keys and sessions go; their pages pass to the acting admin */
  app.delete<{ Params: { id: string } }>("/users/:id", async (req) => {
    const admin = requirePlatformAdmin(req);
    const u = get<{ id: string; login: string; is_platform_admin: number }>("SELECT id, login, is_platform_admin FROM users WHERE id = ?", req.params.id);
    if (!u) throw notFound("User not found");
    if (u.id === admin.id) throw badRequest("You cannot remove your own account");
    if (u.is_platform_admin === 1 && get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE is_platform_admin = 1 AND disabled = 0")!.n <= 1) throw badRequest("This is the only platform administrator");
    const projects = all<{ project_id: string }>("SELECT project_id FROM project_members WHERE user_id = ?", u.id).map((r) => r.project_id);
    tx(() => {
      const moved = run("UPDATE pages SET owner_id = ? WHERE owner_id = ?", admin.id, u.id);
      run("DELETE FROM users WHERE id = ?", u.id); // memberships, sessions, keys and data source logins cascade
      audit(null, admin.id, "user.remove", u.id, { login: u.login, projects: projects.length, pagesMovedTo: admin.id, pages: Number(moved.changes ?? 0) });
      for (const p of projects) audit(p, admin.id, "member.remove", u.id, { login: u.login, reason: "account removed" });
    });
    return { ok: true, projects: projects.length };
  });

  app.patch<{ Params: { id: string } }>("/users/:id", async (req) => {
    const admin = requirePlatformAdmin(req);
    const body = z.object({ name: z.string().optional(), password: z.string().min(8).optional(), isPlatformAdmin: z.boolean().optional(), disabled: z.boolean().optional() }).parse(req.body);
    const u = get<{ id: string; is_platform_admin: number; disabled: number; display_name: string | null; password_hash: string | null }>("SELECT * FROM users WHERE id = ?", req.params.id);
    if (!u) throw notFound("User not found");
    if (req.params.id === admin.id && (body.isPlatformAdmin === false || body.disabled)) throw badRequest("You cannot remove your own admin access");
    if (body.disabled && u.is_platform_admin === 1 && get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE is_platform_admin = 1 AND disabled = 0")!.n <= 1) throw badRequest("This is the only platform administrator");
    run(
      "UPDATE users SET display_name = ?, password_hash = ?, is_platform_admin = ?, disabled = ? WHERE id = ?",
      body.name ?? u.display_name, body.password ? hashPassword(body.password) : u.password_hash,
      body.isPlatformAdmin === undefined ? u.is_platform_admin : body.isPlatformAdmin ? 1 : 0,
      body.disabled === undefined ? u.disabled : body.disabled ? 1 : 0, u.id,
    );
    if (body.disabled || body.password) run("DELETE FROM sessions WHERE user_id = ?", u.id);
    audit(null, admin.id, "user.update", u.id, { ...body, password: body.password ? "(changed)" : undefined });
    // a platform-wide disable/enable is visible in every project the user belongs to
    if (body.disabled !== undefined && body.disabled !== (u.disabled === 1)) for (const r of all<{ project_id: string }>("SELECT project_id FROM project_members WHERE user_id = ?", u.id)) audit(r.project_id, admin.id, body.disabled ? "member.disable" : "member.enable", u.id, { platform: true });
    return { ok: true };
  });

  /* a form user forgot their password: a platform admin sets a new one (the user is signed out everywhere) */
  app.post<{ Params: { id: string } }>("/users/:id/password", async (req) => {
    const admin = requirePlatformAdmin(req);
    const body = z.object({ password: z.string().min(8) }).parse(req.body);
    setPasswordFor(req.params.id, body.password, admin.id, null);
    return { ok: true };
  });
}
