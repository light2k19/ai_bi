import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { z } from "zod";
import { requireProject } from "../services/access";
import { moduleFile, projectModules, resolveModule, setModuleStatus, storeVendored, attachToProject, importMapFor } from "../services/modules";
import { badRequest, notFound } from "../lib/errors";
import { ModuleRef } from "@aibi/page-spec";

export async function moduleRoutes(app: FastifyInstance) {
  // content-addressed module files: public, immutable, loadable from the runtime origin
  app.get<{ Params: { file: string } }>("/modules/:file", async (req, reply) => {
    const m = /^([a-f0-9]{64})\.mjs$/.exec(req.params.file);
    if (!m) throw notFound();
    const f = moduleFile(m[1]);
    if (!fs.existsSync(f)) throw notFound();
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff")
      .type("text/javascript; charset=utf-8");
    return fs.readFileSync(f, "utf8");
  });

  app.get<{ Params: { p: string } }>("/projects/:p/modules", async (req) => {
    const { project } = requireProject(req, req.params.p);
    return projectModules(project.id);
  });

  app.post<{ Params: { p: string } }>("/projects/:p/modules/resolve", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "builder");
    const body = z.object({ name: z.string(), version: z.string(), source: z.enum(["registry", "url"]).default("registry"), registry: z.string().optional(), url: z.string().url().optional(), providesWidgets: z.array(z.string()).optional() }).parse(req.body);
    const m = await resolveModule(project.id, body, user.id);
    return { name: m.name, version: m.version, source: body.source, registry: body.registry, url: body.url, hash: m.hash, integrity: m.integrity, files: m.files.length, providesWidgets: body.providesWidgets };
  });

  /* upload a single-file ESM module (bundled) */
  app.post<{ Params: { p: string } }>("/projects/:p/modules/upload", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "builder");
    const file = await req.file();
    if (!file) throw badRequest("Attach an .mjs/.js file");
    const fields = file.fields as Record<string, { value?: string } | undefined>;
    const name = fields.name?.value;
    const version = fields.version?.value;
    if (!name || !version) throw badRequest("name and version fields are required");
    ModuleRef.pick({ name: true }).parse({ name });
    if (!/^\d+\.\d+\.\d+/.test(version)) throw badRequest("version must be exact, e.g. 1.0.0");
    const content = (await file.toBuffer()).toString("utf8");
    const providesWidgets = fields.providesWidgets?.value ? fields.providesWidgets.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const m = storeVendored({ name, version, entryContent: content, source: "bundled", providesWidgets });
    attachToProject(project.id, name, version, user.id);
    return { name, version, source: "bundled", hash: m.hash, integrity: m.integrity, providesWidgets };
  });

  app.post<{ Params: { p: string } }>("/projects/:p/modules/status", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    const body = z.object({ name: z.string(), version: z.string(), status: z.enum(["approved", "rejected"]) }).parse(req.body);
    setModuleStatus(project.id, body.name, body.version, body.status, user.id);
    return { ok: true };
  });

  /* import map for a set of module refs (runtime) */
  app.post<{ Params: { p: string } }>("/projects/:p/modules/import-map", async (req) => {
    requireProject(req, req.params.p);
    const body = z.object({ modules: z.array(ModuleRef) }).parse(req.body);
    return importMapFor(body.modules);
  });
}
