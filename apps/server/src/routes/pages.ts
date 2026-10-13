import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { PageBundle, validatePage, emptyPage } from "@aibi/page-spec";
import { requireProject, requireScope, roleAtLeast } from "../services/access";
import { catalogueFor, getSkill } from "../skills/registry";
import {
  listPages,
  loadPage,
  getVersion,
  listVersions,
  createPage,
  saveVersion,
  updateMeta,
  deletePage,
  versionDiff,
  deleteVersion,
  setVersionEnabled,
  setDefaultVersion,
  seesAllVersions,
  pageMeta,
  canEdit,
} from "../services/pages";
import { exportPackage } from "../services/packages";
import { computeDatasets } from "../services/compute";
import { createRenderToken, renderUrl } from "../services/render";
import { badRequest, HttpError } from "../lib/errors";
import { newId } from "../lib/crypto";
import { audit } from "../services/audit";

function versionNo(raw: string) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest("version must be a positive integer");
  return n;
}

function download(reply: FastifyReply, body: Buffer | Uint8Array, filename: string, mime: string) {
  reply.header("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`).type(mime);
  return reply.send(Buffer.from(body));
}

async function runExport(format: string, projectId: string, user: Parameters<typeof computeDatasets>[1], bundle: PageBundle, rawFilters: Record<string, unknown>, token: string | null, options: Record<string, unknown>) {
  const skillId = format === "pdf" ? "export-pdf" : format === "xlsx" ? "export-excel" : null;
  if (!skillId) throw badRequest("format must be pdf or xlsx");
  const skill = getSkill(skillId);
  if (!skill?.server?.export) throw badRequest(`${skillId} is not available${skill?.loadError ? `: ${skill.loadError}` : ""}`);
  const { frames, filters } = format === "xlsx" ? await computeDatasets(projectId, user, bundle, { rawFilters, kind: "export" }) : { frames: {}, filters: {} };
  try {
    return await skill.server.export.export(format, {
      bundle,
      datasets: Object.fromEntries(Object.entries(frames).map(([k, f]) => [k, { columns: f.columns, rows: f.rows }])),
      filters,
      renderUrl: token ? renderUrl(token, "internal") : undefined,
      options,
    });
  } catch (e) {
    throw new HttpError(501, `Export failed: ${(e as Error).message}`);
  }
}

export async function pageRoutes(app: FastifyInstance) {
  app.get<{ Params: { p: string } }>("/projects/:p/pages", async (req) => {
    requireScope(req, "page:read");
    const { project, user, role } = requireProject(req, req.params.p);
    return listPages(project.id, user, role);
  });

  app.post<{ Params: { p: string } }>("/projects/:p/pages", async (req) => {
    requireScope(req, "page:import");
    const { project, user } = requireProject(req, req.params.p, "builder");
    const body = z.object({ bundle: z.unknown().optional(), title: z.string().optional(), message: z.string().optional(), visibility: z.enum(["private", "project"]).optional(), source: z.enum(["ai", "manual", "import"]).default("manual"), aiSessionId: z.string().optional() }).parse(req.body);
    const bundle = body.bundle ?? emptyPage(newId("pg"), body.title ?? "Untitled page");
    return createPage(project.id, user, bundle as never, { message: body.message, source: body.source, aiSessionId: body.aiSessionId, visibility: body.visibility });
  });

  app.get<{ Params: { p: string; id: string }; Querystring: { version?: string } }>("/projects/:p/pages/:id", async (req) => {
    requireScope(req, "page:read");
    const { project, user, role } = requireProject(req, req.params.p);
    const page = loadPage(project.id, req.params.id, user, role);
    const v = getVersion(page.id, req.query.version ? Number(req.query.version) : page.current_version, { includeDisabled: seesAllVersions(role) || !req.query.version });
    const meta = pageMeta(page, role);
    // a page whose versions are all off: members get its metadata (it is listed as disabled), not its design
    return { meta, version: { versionNo: v.versionNo, enabled: v.enabled, message: v.message, source: v.source, createdAt: v.createdAt }, bundle: meta.available || seesAllVersions(role) ? v.bundle : null, canEdit: canEdit(page, user, role) };
  });

  app.patch<{ Params: { p: string; id: string } }>("/projects/:p/pages/:id", async (req) => {
    const { project, user, role } = requireProject(req, req.params.p, "builder");
    const page = loadPage(project.id, req.params.id, user, role, "edit");
    const body = z.object({ visibility: z.enum(["private", "project"]).optional(), ownerId: z.string().optional() }).parse(req.body);
    if (body.ownerId && page.owner_id !== user.id && !roleAtLeast(role, "admin")) throw badRequest("Only the owner or an admin can transfer a page");
    updateMeta(project.id, page, user, body);
    return { ok: true };
  });

  app.delete<{ Params: { p: string; id: string } }>("/projects/:p/pages/:id", async (req) => {
    const { project, user, role } = requireProject(req, req.params.p, "builder");
    const page = loadPage(project.id, req.params.id, user, role, "edit");
    if (page.owner_id !== user.id && !roleAtLeast(role, "admin")) throw badRequest("Only the owner or an admin can delete a page");
    deletePage(project.id, page, user);
    return { ok: true };
  });

  app.post<{ Params: { p: string; id: string } }>("/projects/:p/pages/:id/versions", async (req) => {
    requireScope(req, "page:import");
    const { project, user, role } = requireProject(req, req.params.p, "builder");
    const page = loadPage(project.id, req.params.id, user, role, "edit");
    const body = z.object({ bundle: z.unknown(), message: z.string().optional(), baseVersion: z.number().int().optional(), force: z.boolean().optional(), source: z.enum(["ai", "manual", "import"]).default("manual"), aiSessionId: z.string().optional() }).parse(req.body);
    return saveVersion(project.id, page, user, body.bundle, { message: body.message, source: body.source, baseVersion: body.baseVersion, force: body.force, aiSessionId: body.aiSessionId });
  });

  app.get<{ Params: { p: string; id: string } }>("/projects/:p/pages/:id/versions", async (req) => {
    const { project, user, role } = requireProject(req, req.params.p);
    const page = loadPage(project.id, req.params.id, user, role);
    return listVersions(page.id, seesAllVersions(role));
  });

  /* admins switch a version off (hidden from everyone else) or on, and choose the default version */
  app.patch<{ Params: { p: string; id: string; n: string } }>("/projects/:p/pages/:id/versions/:n", async (req) => {
    const { project, user, role } = requireProject(req, req.params.p, "admin");
    const page = loadPage(project.id, req.params.id, user, role);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    return setVersionEnabled(project.id, page, user, versionNo(req.params.n), body.enabled);
  });

  app.put<{ Params: { p: string; id: string; n: string } }>("/projects/:p/pages/:id/versions/:n/default", async (req) => {
    const { project, user, role } = requireProject(req, req.params.p, "admin");
    const page = loadPage(project.id, req.params.id, user, role);
    return setDefaultVersion(project.id, page, user, versionNo(req.params.n));
  });

  app.delete<{ Params: { p: string; id: string; n: string }; Querystring: { deletePage?: string } }>("/projects/:p/pages/:id/versions/:n", async (req) => {
    const { project, user, role } = requireProject(req, req.params.p, "admin");
    const page = loadPage(project.id, req.params.id, user, role);
    return deleteVersion(project.id, page, user, versionNo(req.params.n), { confirmPageDelete: req.query.deletePage === "1" });
  });

  app.get<{ Params: { p: string; id: string }; Querystring: { from: string; to: string } }>("/projects/:p/pages/:id/diff", async (req) => {
    const { project, user, role } = requireProject(req, req.params.p);
    const page = loadPage(project.id, req.params.id, user, role);
    if (!seesAllVersions(role)) for (const n of [Number(req.query.from), Number(req.query.to)]) getVersion(page.id, n, { includeDisabled: false });
    return versionDiff(page.id, Number(req.query.from), Number(req.query.to));
  });

  /* validation without saving (editor, local drafts, CLI) */
  app.post<{ Params: { p: string } }>("/projects/:p/validate", async (req) => {
    requireScope(req, "page:read");
    const { project } = requireProject(req, req.params.p);
    const body = z.object({ bundle: z.unknown(), strict: z.boolean().default(true) }).parse(req.body);
    const v = validatePage(body.bundle, { catalogue: catalogueFor(project.id), strictCatalogue: body.strict });
    return { ok: v.ok, errors: v.errors, warnings: v.warnings, requires: v.requires };
  });

  /* ───────── exports ───────── */
  app.get<{ Params: { p: string; id: string }; Querystring: { version?: string; vendor?: string; sample?: string; anonymise?: string; gallery?: string } }>("/projects/:p/pages/:id/export", async (req, reply) => {
    const { project, user, role } = requireProject(req, req.params.p);
    const page = loadPage(project.id, req.params.id, user, role);
    if (req.query.gallery === "1" && !roleAtLeast(role, "builder")) throw badRequest("Publishing to the gallery requires the builder role");
    if (req.query.version) getVersion(page.id, Number(req.query.version), { includeDisabled: seesAllVersions(role) });
    const pkg = await exportPackage(project.id, page, user, {
      versionNo: req.query.version ? Number(req.query.version) : undefined,
      vendorModules: req.query.vendor !== "0",
      sampleData: req.query.sample === "1",
      anonymise: req.query.anonymise === "1",
      gallery: req.query.gallery === "1",
    });
    return download(reply, pkg.buffer, pkg.filename, "application/zip");
  });

  // PDF / Excel of a saved page with the viewer's current filters
  app.post<{ Params: { p: string; id: string; format: string } }>("/projects/:p/pages/:id/export/:format", async (req, reply) => {
    const { project, user, role } = requireProject(req, req.params.p);
    const page = loadPage(project.id, req.params.id, user, role);
    const body = z.object({ versionNo: z.number().int().optional(), filters: z.record(z.unknown()).default({}), options: z.record(z.unknown()).default({}) }).parse(req.body ?? {});
    const v = getVersion(page.id, body.versionNo ?? page.current_version);
    const token = req.params.format === "pdf" ? createRenderToken({ projectId: project.id, userId: user.id, mode: "page", pageId: page.id, versionNo: v.versionNo, filters: body.filters }) : null;
    const out = await runExport(req.params.format, project.id, user, v.bundle, body.filters, token, body.options);
    audit(project.id, user.id, `page.export.${req.params.format}`, page.id);
    return download(reply, out.body as Buffer, out.filename, out.mime);
  });

  // PDF / Excel of an unsaved draft (builders)
  app.post<{ Params: { p: string; format: string } }>("/projects/:p/export/:format", async (req, reply) => {
    const { project, user } = requireProject(req, req.params.p, "builder");
    const body = z.object({ bundle: z.unknown(), filters: z.record(z.unknown()).default({}), options: z.record(z.unknown()).default({}) }).parse(req.body);
    const bundle = PageBundle.parse(body.bundle);
    const token = req.params.format === "pdf" ? createRenderToken({ projectId: project.id, userId: user.id, mode: "draft", filters: body.filters }, bundle) : null;
    const out = await runExport(req.params.format, project.id, user, bundle, body.filters, token, body.options);
    return download(reply, out.body as Buffer, out.filename, out.mime);
  });
}
