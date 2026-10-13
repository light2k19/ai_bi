import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { config } from "../config";
import { providerStatus } from "../ai/status";
import { providerSettings } from "../ai/provider";
import { all, get, run, now, json, parse } from "../db";
import { hashPassword, verifyPassword, newId, randomToken, sha256, openSecrets } from "../lib/crypto";
import { badRequest, forbidden, unauthorized, notFound, tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/cache";

const loginLimiter = new RateLimiter();
import { SESSION_COOKIE, requireUser, findProject, memberRole, roleAtLeast } from "../services/access";
import { getSkill } from "../skills/registry";
import { audit } from "../services/audit";
import { syncSystemLogins } from "../services/sources";

function systemSkillSettings(id: string): { enabled: boolean; settings: Record<string, unknown> } {
  const r = get<{ enabled: number; settings: string }>("SELECT enabled, settings FROM system_skill_settings WHERE skill_id = ?", id);
  const skill = getSkill(id);
  const enabled = r ? r.enabled === 1 : (skill?.manifest.defaultEnabled ?? false);
  return { enabled, settings: openSecrets(parse(r?.settings, {}), skill?.manifest.secrets ?? []) };
}

export function authProviders() {
  const out: { id: string; label: string; kind: "password" | "redirect"; skill: string }[] = [];
  if (systemSkillSettings("auth-local").enabled) out.push({ id: "local", label: "Email and password", kind: "password", skill: "auth-local" });
  for (const id of ["auth-oidc", "auth-ldap"]) {
    const s = getSkill(id);
    const st = systemSkillSettings(id);
    if (!s?.server?.auth || !st.enabled) continue;
    for (const p of s.server.auth.providers(st.settings)) out.push({ ...p, skill: id });
  }
  return out;
}

function startSession(reply: FastifyReply, userId: string) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  run("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)", sha256(token), userId, now(), expires.toISOString());
  run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), userId);
  run("DELETE FROM sessions WHERE expires_at < ?", now());
  reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure: config.secureCookies, expires });
}

export function userProjects(userId: string, isAdmin: boolean) {
  const rows = isAdmin
    ? all<{ id: string; slug: string; name: string; description: string | null; role: string | null }>(
        "SELECT p.id, p.slug, p.name, p.description, m.role FROM projects p LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ? WHERE p.archived = 0 ORDER BY p.name",
        userId,
      )
    : all<{ id: string; slug: string; name: string; description: string | null; role: string | null }>(
        "SELECT p.id, p.slug, p.name, p.description, m.role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? AND m.enabled = 1 AND p.archived = 0 ORDER BY p.name",
        userId,
      );
  // how many data source logins the user has saved in each project (drives "Sign out of data sources")
  const logins = new Map(all<{ project_id: string; n: number }>("SELECT i.project_id, COUNT(*) AS n FROM user_source_credentials c JOIN skill_instances i ON i.id = c.instance_id WHERE c.user_id = ? AND i.system_login = 0 GROUP BY i.project_id", userId).map((x) => [x.project_id, x.n]));
  return rows.map((r) => ({ ...r, role: r.role ?? (isAdmin ? "admin" : null), dataSourceLogins: logins.get(r.id) ?? 0 }));
}

export async function authRoutes(app: FastifyInstance) {
  app.get("/config", async () => {
    const users = get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n;
    return {
      version: config.appVersion,
      webOrigin: config.webOrigin,
      runtimeOrigin: config.runtimeOrigin,
      apiUrl: config.publicApiUrl,
      needsSetup: users === 0,
      providers: authProviders().map(({ id, label, kind }) => ({ id, label, kind })),
      ai: { configured: Boolean(config.ai.apiKey) || !/openrouter/.test(config.ai.baseUrl), model: config.ai.model, baseUrl: config.ai.baseUrl.replace(/\/\/[^/]*@/, "//"), ...(await providerStatus(providerSettings())) },
    };
  });

  app.post("/auth/setup", async (req, reply) => {
    const body = z.object({ login: z.string().trim().min(2).max(100).optional(), email: z.string().email(), password: z.string().min(8), name: z.string().optional() }).parse(req.body);
    if (get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n > 0) throw forbidden("Setup is already complete");
    const id = newId("usr");
    run("INSERT INTO users (id, login, email, display_name, password_hash, auth_provider, is_platform_admin, created_at) VALUES (?,?,?,?,?,?,?,?)", id, body.login ?? body.email, body.email, body.name ?? null, hashPassword(body.password), "local", 1, now());
    audit(null, id, "setup.admin", id);
    startSession(reply, id);
    return { ok: true };
  });

  /** The Active Directory skill when it is enabled and loaded. */
  const ldapAuth = () => {
    const s = getSkill("auth-ldap");
    const st = systemSkillSettings("auth-ldap");
    return s?.server?.auth?.verifyPassword && st.enabled ? { auth: s.server.auth, settings: st.settings } : null;
  };

  /* form users: email + password checked here; AD users: user id (or email) + password checked by the directory */
  app.post("/auth/login", async (req, reply) => {
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const login = body.email.trim();
    if (!loginLimiter.check(`ip:${req.ip}`, config.limits.loginsPerMinute) || !loginLimiter.check(`email:${login.toLowerCase()}`, 10)) throw tooMany("Too many sign-in attempts; try again in a minute");
    // the login id (form users: whatever the admin chose; AD users: the Windows id) or the email
    let u = get<{ id: string; login: string; email: string | null; password_hash: string | null; disabled: number; auth_provider: string }>(
      "SELECT id, login, email, password_hash, disabled, auth_provider FROM users WHERE login = ? COLLATE NOCASE OR email = ? OR (auth_provider = 'ldap' AND login = ? COLLATE NOCASE)", login, login, login.replace(/@.*$/, ""));
    const ldap = ldapAuth();
    if (u?.auth_provider === "ldap" || (!u && ldap && ldap.settings.autoCreateUsers === true)) {
      if (!ldap) throw forbidden("Active Directory sign-in is disabled");
      const ident = await ldap.auth.verifyPassword!(ldap.settings, login, body.password).catch((e: Error) => {
        throw unauthorized(`Active Directory sign-in failed: ${e.message}`);
      });
      if (!ident) throw unauthorized("Wrong user id or password");
      if (!u) {
        u = ident.email ? get("SELECT id, login, email, password_hash, disabled, auth_provider FROM users WHERE email = ?", ident.email) : undefined;
        if (!u) {
          const id = newId("usr");
          run("INSERT INTO users (id, login, email, display_name, auth_provider, external_id, created_at) VALUES (?,?,?,?,?,?,?)", id, ident.externalId, ident.email, ident.displayName ?? null, "ldap", ident.externalId, now());
          u = { id, login: ident.externalId, email: ident.email, password_hash: null, disabled: 0, auth_provider: "ldap" };
        }
      } else run("UPDATE users SET display_name = COALESCE(?, display_name), email = COALESCE(email, ?) WHERE id = ?", ident.displayName ?? null, ident.email, u.id);
      if (u.disabled) throw unauthorized("Your account is disabled");
    } else {
      if (!systemSkillSettings("auth-local").enabled) throw forbidden("Password sign-in is disabled");
      // constant-ish work on unknown users
      const ok = u ? verifyPassword(body.password, u.password_hash) : (verifyPassword(body.password, hashPassword("x")), false);
      if (!u || !ok || u.disabled) throw unauthorized("Wrong login id or password");
    }
    startSession(reply, u.id);
    audit(null, u.id, "auth.login", u.id, u.auth_provider === "ldap" ? { provider: "ldap" } : undefined);
    // data sources that use the AI BI account get this login too (never fails the sign-in itself)
    try {
      await syncSystemLogins({ id: u.id, login: u.login, email: u.email }, body.password);
    } catch {
      /* best effort */
    }
    return { ok: true };
  });

  app.post("/auth/logout", async (req, reply) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) run("DELETE FROM sessions WHERE id = ?", sha256(sid));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/auth/me", async (req) => {
    const u = requireUser(req);
    return { user: u, projects: userProjects(u.id, u.isPlatformAdmin) };
  });

  /* own display name */
  app.post("/me/profile", async (req) => {
    const u = requireUser(req);
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    run("UPDATE users SET display_name = ? WHERE id = ?", body.name, u.id);
    audit(null, u.id, "user.profile", u.id, { name: body.name });
    return { ok: true };
  });

  app.post("/me/password", async (req) => {
    const u = requireUser(req);
    const body = z.object({ current: z.string(), next: z.string().min(8) }).parse(req.body);
    if (u.authProvider === "ldap") throw badRequest("Your password is managed by Active Directory");
    const row = get<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = ?", u.id);
    if (!verifyPassword(body.current, row?.password_hash)) throw badRequest("Current password is wrong");
    run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(body.next), u.id);
    return { ok: true };
  });

  /* OIDC */
  app.get<{ Params: { provider: string }; Querystring: { returnTo?: string } }>("/auth/oidc/:provider/start", async (req, reply) => {
    const s = getSkill("auth-oidc");
    const st = systemSkillSettings("auth-oidc");
    if (!s?.server?.auth?.start || !st.enabled) throw notFound("Single sign-on is not configured");
    const redirectUri = `${config.publicApiUrl}/api/auth/oidc/${req.params.provider}/callback`;
    const { url, state } = await s.server.auth.start(req.params.provider, st.settings, redirectUri);
    run("DELETE FROM oidc_states WHERE created_at < ?", new Date(Date.now() - 600_000).toISOString());
    const returnTo = req.query.returnTo?.startsWith("/") ? req.query.returnTo : "/";
    run("INSERT INTO oidc_states (state, provider, data, return_to, created_at) VALUES (?,?,?,?,?)", state.state, req.params.provider, json(state), returnTo, now());
    return reply.redirect(url);
  });

  app.get<{ Params: { provider: string }; Querystring: Record<string, string> }>("/auth/oidc/:provider/callback", async (req, reply) => {
    const s = getSkill("auth-oidc");
    const st = systemSkillSettings("auth-oidc");
    if (!s?.server?.auth?.callback) throw notFound("Single sign-on is not configured");
    const saved = get<{ data: string; return_to: string }>("SELECT data, return_to FROM oidc_states WHERE state = ? AND provider = ?", req.query.state ?? "", req.params.provider);
    if (!saved) throw badRequest("Sign-in session expired; try again");
    run("DELETE FROM oidc_states WHERE state = ?", req.query.state);
    if (req.query.error) throw badRequest(`Sign-in failed: ${req.query.error_description ?? req.query.error}`);
    const redirectUri = `${config.publicApiUrl}/api/auth/oidc/${req.params.provider}/callback`;
    const ident = await s.server.auth.callback(req.params.provider, st.settings, redirectUri, req.query, parse(saved.data, {}));
    if (!ident.email) throw badRequest("The identity provider returned no email address");
    let u = get<{ id: string; disabled: number }>("SELECT id, disabled FROM users WHERE external_id = ? OR email = ?", ident.externalId, ident.email);
    const providerCfg = ((st.settings.providers as { id: string; autoCreateUsers?: boolean }[] | undefined) ?? []).find((p) => p.id === req.params.provider);
    if (!u) {
      if (providerCfg?.autoCreateUsers === false) throw forbidden("Your account is not registered; ask an administrator");
      const id = newId("usr");
      run("INSERT INTO users (id, login, email, display_name, auth_provider, external_id, created_at) VALUES (?,?,?,?,?,?,?)", id, ident.email, ident.email, ident.displayName ?? null, req.params.provider, ident.externalId, now());
      u = { id, disabled: 0 };
    } else run("UPDATE users SET external_id = COALESCE(external_id, ?), display_name = COALESCE(display_name, ?) WHERE id = ?", ident.externalId, ident.displayName ?? null, u.id);
    if (u.disabled) throw forbidden("Your account is disabled");
    startSession(reply, u.id);
    audit(null, u.id, "auth.login", u.id, { provider: req.params.provider });
    return reply.redirect(`${config.webOrigin}${saved.return_to || "/"}`);
  });

  /* personal access tokens */
  app.get("/me/tokens", async (req) => {
    const u = requireUser(req);
    return all<{ id: string; name: string; prefix: string; scopes: string; project_id: string | null; expires_at: string | null; last_used_at: string | null; revoked: number; created_at: string }>(
      "SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC",
      u.id,
    ).map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, scopes: parse(t.scopes, []), projectId: t.project_id, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, revoked: t.revoked === 1, createdAt: t.created_at }));
  });

  app.post("/me/tokens", async (req) => {
    const u = requireUser(req);
    if (req.pat) throw forbidden("tokens cannot create tokens");
    const body = z
      .object({
        name: z.string().min(1).max(80),
        project: z.string(),
        scopes: z.array(z.enum(["query:read", "page:read", "page:import", "mcp"])).min(1),
        days: z.number().int().min(1).max(365).default(30),
      })
      .parse(req.body);
    const p = findProject(body.project);
    if (!p || !memberRole(p.id, u)) throw notFound("Project not found");
    // external access keys are an admin tool: only a project admin (or platform admin) may issue one for a project
    if (!roleAtLeast(memberRole(p.id, u)!, "admin")) throw forbidden("Only a project admin can create an external access key for this project");
    const token = `aibi_pat_${randomToken(30)}`;
    const id = newId("tok");
    run(
      "INSERT INTO api_tokens (id, user_id, project_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id, u.id, p.id, body.name, sha256(token), token.slice(0, 14), json(body.scopes), new Date(Date.now() + body.days * 86400_000).toISOString(), now(),
    );
    audit(p.id, u.id, "token.create", id, { scopes: body.scopes, days: body.days });
    return { id, token, note: "Copy this token now; it is not shown again." };
  });

  app.delete<{ Params: { id: string } }>("/me/tokens/:id", async (req) => {
    const u = requireUser(req);
    run("UPDATE api_tokens SET revoked = 1 WHERE id = ? AND user_id = ?", req.params.id, u.id);
    return { ok: true };
  });
}

export { systemSkillSettings };
