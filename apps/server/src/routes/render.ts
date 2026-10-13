import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PageBundle } from "@aibi/page-spec";
import { config } from "../config";
import { get } from "../db";
import { requireProject, roleAtLeast, memberRole, type User } from "../services/access";
import { createRenderToken, readRenderToken, renderUrl } from "../services/render";
import { getVersion, loadPage } from "../services/pages";
import { runQuery } from "../services/gateway";
import { catalogueFor, clientSkills, themeTokens } from "../skills/registry";
import { badRequest, forbidden, notFound, unauthorized } from "../lib/errors";

function claimsUser(userId: string): User {
  const u = get<{ id: string; login: string; email: string | null; display_name: string | null; is_platform_admin: number; disabled: number; auth_provider: string }>("SELECT * FROM users WHERE id = ?", userId);
  if (!u || u.disabled) throw unauthorized("Render token user is not active");
  return { id: u.id, login: u.login, email: u.email, displayName: u.display_name, isPlatformAdmin: u.is_platform_admin === 1, authProvider: u.auth_provider };
}

export async function renderRoutes(app: FastifyInstance) {
  app.post<{ Params: { p: string } }>("/projects/:p/render-token", async (req) => {
    const body = z
      .object({ mode: z.enum(["page", "draft"]), pageId: z.string().optional(), versionNo: z.number().int().optional(), bundle: z.unknown().optional(), filters: z.record(z.unknown()).optional() })
      .parse(req.body);
    const { project, user, role } = requireProject(req, req.params.p, body.mode === "draft" ? "builder" : "viewer");
    if (body.mode === "page" && !body.pageId) throw badRequest("pageId is required");
    // the token can only render a page of this project that the user may view
    if (body.mode === "page") loadPage(project.id, body.pageId!, user, role);
    const token = createRenderToken(
      { projectId: project.id, userId: user.id, mode: body.mode, pageId: body.pageId, versionNo: body.versionNo, filters: body.filters },
      body.mode === "draft" ? PageBundle.parse(body.bundle) : undefined,
    );
    return { token, url: renderUrl(token) };
  });

  app.get<{ Params: { token: string } }>("/render/:token", async (req) => {
    const c = readRenderToken(req.params.token);
    if (!c) throw unauthorized("Render link expired");
    const user = claimsUser(c.userId);
    const project = get<{ id: string; slug: string; settings: string }>("SELECT id, slug, settings FROM projects WHERE id = ?", c.projectId);
    const role = project ? memberRole(project.id, user) : null;
    if (!project || !role) throw forbidden();
    let bundle: PageBundle;
    if (c.mode === "draft") {
      if (!c.draft) throw notFound("Draft expired");
      bundle = c.draft;
    } else {
      loadPage(project.id, c.pageId!, user, role);
      bundle = getVersion(c.pageId!, c.versionNo).bundle;
    }
    return {
      projectSlug: project.slug,
      mode: c.mode,
      pageId: c.pageId,
      versionNo: c.versionNo,
      filters: c.filters ?? {},
      bundle,
      runtimeConfig: {
        catalogue: catalogueFor(project.id),
        clientSkills: clientSkills(project.id),
        theme: themeTokens(project.id),
        embedHosts: [],
        runtimeOrigin: config.runtimeOrigin,
        apiUrl: config.publicApiUrl,
      },
    };
  });

  app.post<{ Params: { token: string } }>("/render/:token/narrative", async (req) => {
    const c = readRenderToken(req.params.token);
    if (!c) throw unauthorized("Render link expired");
    const user = claimsUser(c.userId);
    const role = memberRole(c.projectId, user);
    if (!role) throw forbidden();
    const body = z
      .object({
        widgetId: z.string(),
        prompt: z.string().max(4000),
        maxWords: z.number().int().optional(),
        page: z.object({ title: z.string(), description: z.string().optional(), filters: z.record(z.unknown()).optional() }).optional(),
        datasets: z.array(z.object({ id: z.string(), columns: z.array(z.object({ name: z.string(), type: z.string() })), rows: z.array(z.record(z.unknown())).max(500), totalRows: z.number().optional() })).max(10),
      })
      .parse(req.body);
    if (c.mode === "page") loadPage(c.projectId, c.pageId!, user, role);
    const { askAboutPage } = await import("../ai/ask");
    return askAboutPage({ projectId: c.projectId, user, role, question: body.prompt, page: body.page, datasets: body.datasets, maxWords: body.maxWords ?? 150, cacheKey: `${c.pageId ?? "draft"}:${body.widgetId}`, pageId: c.pageId ?? null });
  });

  app.post<{ Params: { token: string } }>("/render/:token/query", async (req) => {
    const c = readRenderToken(req.params.token);
    if (!c) throw unauthorized("Render link expired");
    const user = claimsUser(c.userId);
    const role = memberRole(c.projectId, user);
    if (!role) throw forbidden();
    const body = z.object({ datasetId: z.string().optional(), source: z.string().optional(), request: z.record(z.unknown()).optional(), filters: z.record(z.unknown()).default({}) }).parse(req.body);
    if (c.mode === "page") {
      loadPage(c.projectId, c.pageId!, user, role);
      const v = getVersion(c.pageId!, c.versionNo);
      const d = v.bundle.page.datasets.find((x) => x.id === body.datasetId);
      if (!d?.source || !d.request) throw badRequest("Unknown dataset");
      return runQuery({ projectId: c.projectId, userId: user.id, userEmail: user.email ?? user.login, alias: d.source, request: d.request, scope: { filters: body.filters, page: { id: c.pageId, title: v.bundle.page.title } }, kind: "export", pageId: c.pageId, ttlSeconds: d.cache?.ttlSeconds ?? 60 });
    }
    // draft mode: ad-hoc requests restricted to the draft's own datasets
    if (!roleAtLeast(role, "builder")) throw forbidden();
    const d = c.draft?.page.datasets.find((x) => x.id === body.datasetId) ?? c.draft?.page.datasets.find((x) => x.source === body.source && JSON.stringify(x.request) === JSON.stringify(body.request));
    if (!d?.source || !d.request) throw badRequest("Unknown dataset");
    return runQuery({ projectId: c.projectId, userId: user.id, userEmail: user.email ?? user.login, alias: d.source, request: d.request, scope: { filters: body.filters, page: { id: c.draft!.page.id, title: c.draft!.page.title } }, kind: "export", ttlSeconds: 60 });
  });
}
