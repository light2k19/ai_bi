import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PageBundle } from "@aibi/page-spec";
import { requireProject, requireScope, requirePlatformAdmin } from "../services/access";
import { analyzeImport, getImport, commitImport, gallery, packageFile, readUpload } from "../services/packages";
import { badRequest } from "../lib/errors";
import { run, get } from "../db";
import fs from "node:fs";
import { ensureSchema, schemaText } from "../services/sources";
import { complete, providerSettings } from "../ai/provider";
import { checkAiAllowed, recordUsage } from "../ai/orchestrator";
import { projectSettings } from "../skills/registry";
import { checkReadOnly, type Dialect } from "@aibi/sql-guard";
import { buildAuthoringKit } from "../services/authoring-kit";
import { audit } from "../services/audit";

export async function packageRoutes(app: FastifyInstance) {
  /* upload a .aibi package, page bundle JSON or page JSON and get a compatibility report */
  app.post<{ Params: { p: string } }>("/projects/:p/import/analyze", async (req) => {
    requireScope(req, "page:import");
    const { project, user } = requireProject(req, req.params.p, "builder");
    let buf: Buffer;
    let filename = "upload";
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw badRequest("Attach a .aibi or .json file");
      buf = await file.toBuffer();
      filename = file.filename;
    } else {
      const body = z.object({ bundle: z.unknown() }).parse(req.body);
      buf = Buffer.from(JSON.stringify(body.bundle));
      filename = "bundle.json";
    }
    return analyzeImport(project.id, user, buf, filename);
  });

  app.get<{ Params: { p: string; id: string } }>("/projects/:p/import/:id", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "builder");
    const imp = getImport(project.id, req.params.id, user);
    return { status: imp.status, report: imp.report };
  });

  app.post<{ Params: { p: string; id: string } }>("/projects/:p/import/:id/commit", async (req) => {
    requireScope(req, "page:import");
    const { project, user } = requireProject(req, req.params.p, "builder");
    const body = z.object({ mapping: z.record(z.string()).default({}), mode: z.enum(["new", "version", "copy"]), title: z.string().optional(), sqlOverrides: z.record(z.string()).optional(), overwrite: z.boolean().optional() }).parse(req.body);
    return commitImport(project.id, user, req.params.id, body);
  });

  /* AI-assisted SQL rewrite when the target data source lacks tables/columns the package expects */
  app.post<{ Params: { p: string; id: string } }>("/projects/:p/import/:id/rewrite", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "builder");
    const body = z.object({ alias: z.string(), target: z.string() }).parse(req.body);
    const imp = getImport(project.id, req.params.id, user);
    const up = readUpload(fs.readFileSync(imp.storage_path), "upload");
    const bundle = PageBundle.parse(up.bundle);
    const target = await ensureSchema(project.id, body.target, user.id);
    const dialect = (target.snapshot?.dialect ?? "mysql") as Dialect;
    await checkAiAllowed(project.id, user.id);
    const settings = providerSettings(projectSettings(project.id));
    const out: Record<string, { original: string; proposed: string; ok: boolean; errors: string[] }> = {};
    for (const d of bundle.page.datasets.filter((x) => x.source === body.alias && typeof x.request?.sql === "string")) {
      const original = d.request!.sql as string;
      const r = await complete(settings, [
        { role: "system", content: "You adapt SQL queries to a different database schema. Keep the same output column names and parameters (:name). Reply with only the SQL, no commentary, no code fences." },
        { role: "user", content: `Target dialect: ${dialect}\nTarget schema:\n${schemaText(target.snapshot, target.annotations, { maxChars: 20_000 })}\n\nOriginal query:\n${original}\n\nRewrite it for the target schema.` },
      ]);
      recordUsage(project.id, user.id, null, "import-rewrite", r.model, r.usage);
      const proposed = r.text.replace(/^```(?:sql)?\s*|\s*```$/g, "").trim();
      const ro = checkReadOnly(proposed, dialect);
      out[d.id] = { original, proposed, ok: ro.ok, errors: ro.errors };
    }
    return out;
  });

  /* gallery and package downloads */
  app.get<{ Params: { p: string } }>("/projects/:p/gallery", async (req) => {
    const { project } = requireProject(req, req.params.p);
    return gallery(project.id);
  });

  app.get<{ Params: { p: string; id: string } }>("/projects/:p/packages/:id/download", async (req, reply) => {
    const { project } = requireProject(req, req.params.p);
    const f = packageFile(req.params.id, project.id);
    reply.header("Content-Disposition", `attachment; filename="${f.filename}"`).type("application/zip");
    return reply.send(f.buffer);
  });

  /* import a gallery package straight into the analyzer */
  app.post<{ Params: { p: string; id: string } }>("/projects/:p/packages/:id/analyze", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "builder");
    const f = packageFile(req.params.id, project.id);
    return analyzeImport(project.id, user, f.buffer, f.filename, { template: f.kind === "template" });
  });

  app.post<{ Params: { p: string; id: string } }>("/projects/:p/packages/:id/template", async (req) => {
    const u = requirePlatformAdmin(req);
    const { project } = requireProject(req, req.params.p);
    const body = z.object({ template: z.boolean() }).parse(req.body);
    if (!get("SELECT 1 FROM packages WHERE id = ? AND project_id = ?", req.params.id, project.id)) throw badRequest("Package not found");
    run("UPDATE packages SET kind = ? WHERE id = ?", body.template ? "template" : "export", req.params.id);
    audit(project.id, u.id, body.template ? "package.template" : "package.untemplate", req.params.id);
    return { ok: true };
  });

  app.delete<{ Params: { p: string; id: string } }>("/projects/:p/packages/:id/gallery", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    run("UPDATE packages SET gallery = 0 WHERE id = ? AND project_id = ?", req.params.id, project.id);
    audit(project.id, user.id, "package.unpublish", req.params.id);
    return { ok: true };
  });

  /* authoring kit for local AI tools */
  app.get<{ Params: { p: string }; Querystring: { samples?: string } }>("/projects/:p/authoring-kit", async (req, reply) => {
    const { project, user } = requireProject(req, req.params.p, "builder");
    const buf = await buildAuthoringKit(project, user, { samples: req.query.samples === "1" });
    audit(project.id, user.id, "kit.download", project.id, { samples: req.query.samples === "1" });
    reply.header("Content-Disposition", `attachment; filename="aibi-kit-${project.slug}.zip"`).type("application/zip");
    return reply.send(buf);
  });
}
