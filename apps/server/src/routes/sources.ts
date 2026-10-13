import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireProject, requireScope } from "../services/access";
import { audit } from "../services/audit";
import {
  listInstances,
  publicInstance,
  createInstance,
  updateInstance,
  deleteInstance,
  testInstance,
  introspectInstance,
  instanceById,
  schemaOf,
  setAnnotations,
  schemaText,
  myCredentials,
  checkMyCredentials,
  signInWithSystemLogin,
  clearAllMyCredentials,
  setMyCredentials,
  clearCredentials,
  credentialStatus,
  type Annotations,
} from "../services/sources";
import { runQuery } from "../services/gateway";
import { loadPage, getVersion } from "../services/pages";
import { badRequest, notFound, tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/cache";

const credentialLimiter = new RateLimiter();

const annotationsSchema = z.object({
  tables: z.record(z.object({ description: z.string().optional(), hidden: z.boolean().optional(), columns: z.record(z.string()).optional() })).optional(),
  glossary: z.string().optional(),
});

export async function sourceRoutes(app: FastifyInstance) {
  app.get<{ Params: { p: string } }>("/projects/:p/sources", async (req) => {
    const { project, role } = requireProject(req, req.params.p);
    const list = listInstances(project.id).map(publicInstance);
    // viewers see aliases only, not connection details
    return role === "viewer" ? list.map(({ config: _c, ...rest }) => rest) : list;
  });

  app.post<{ Params: { p: string } }>("/projects/:p/sources", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    const body = z.object({ skill: z.string(), name: z.string().min(1), alias: z.string(), description: z.string().optional(), config: z.record(z.unknown()), credentialMode: z.enum(["shared", "user"]).optional(), systemLogin: z.boolean().optional() }).parse(req.body);
    const r = createInstance(project.id, body, user.id);
    audit(project.id, user.id, "source.create", r.id, { alias: body.alias, skill: body.skill });
    return publicInstance(r);
  });

  app.patch<{ Params: { p: string; id: string } }>("/projects/:p/sources/:id", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    const body = z.object({ name: z.string().optional(), description: z.string().optional(), config: z.record(z.unknown()).optional(), status: z.enum(["enabled", "disabled"]).optional(), credentialMode: z.enum(["shared", "user"]).optional(), systemLogin: z.boolean().optional() }).parse(req.body);
    const r = await updateInstance(project.id, req.params.id, body, user.id);
    audit(project.id, user.id, "source.update", r.id, { ...body, config: body.config ? "(changed)" : undefined });
    return publicInstance(r);
  });

  app.delete<{ Params: { p: string; id: string } }>("/projects/:p/sources/:id", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    await deleteInstance(project.id, req.params.id);
    audit(project.id, user.id, "source.delete", req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { p: string; id: string } }>("/projects/:p/sources/:id/test", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    return testInstance(project.id, req.params.id, user.id);
  });

  /* ───────── per-user sign-in ───────── */
  // every member: their own login for each per-user data source (values masked)
  app.get<{ Params: { p: string } }>("/projects/:p/my-credentials", async (req) => {
    const { project, user } = requireProject(req, req.params.p);
    return myCredentials(project.id, user.id);
  });

  // live check before opening a project: which logins are missing or failing
  app.post<{ Params: { p: string } }>("/projects/:p/my-credentials/check", async (req) => {
    const { project, user } = requireProject(req, req.params.p);
    const sources = await checkMyCredentials(project.id, user.id);
    return { ok: sources.every((s) => s.ok), sources };
  });

  // sign in to a data source with the AI BI account (the AI BI password is checked first)
  app.put<{ Params: { p: string; id: string } }>("/projects/:p/sources/:id/my-credentials/system", async (req) => {
    const { project, user } = requireProject(req, req.params.p);
    const body = z.object({ password: z.string() }).parse(req.body);
    if (!credentialLimiter.check(`cred:${user.id}`, 10)) throw tooMany("Too many sign-in attempts; try again in a minute");
    const r = await signInWithSystemLogin(project.id, req.params.id, user, body.password);
    audit(project.id, user.id, r.saved ? "source.credentials.set" : "source.credentials.rejected", req.params.id, { systemLogin: true });
    return r;
  });

  // sign out of the project's data sources (removes all of the user's stored logins there)
  app.delete<{ Params: { p: string } }>("/projects/:p/my-credentials", async (req) => {
    const { project, user } = requireProject(req, req.params.p);
    const removed = await clearAllMyCredentials(project.id, user.id);
    audit(project.id, user.id, "source.credentials.signout", project.id, { removed });
    return { ok: true, removed };
  });

  // saved only after a successful connection test with these values
  app.put<{ Params: { p: string; id: string } }>("/projects/:p/sources/:id/my-credentials", async (req) => {
    const { project, user } = requireProject(req, req.params.p);
    const body = z.object({ values: z.record(z.unknown()) }).parse(req.body);
    if (!credentialLimiter.check(`cred:${user.id}`, 10)) throw tooMany("Too many sign-in attempts; try again in a minute");
    const r = await setMyCredentials(project.id, req.params.id, user.id, body.values);
    audit(project.id, user.id, r.saved ? "source.credentials.set" : "source.credentials.rejected", req.params.id);
    return r;
  });

  app.delete<{ Params: { p: string; id: string } }>("/projects/:p/sources/:id/my-credentials", async (req) => {
    const { project, user } = requireProject(req, req.params.p);
    await clearCredentials(project.id, req.params.id, user.id);
    audit(project.id, user.id, "source.credentials.clear", req.params.id);
    return { ok: true };
  });

  // admins: who has signed in (never the values), and clearing a member's login
  app.get<{ Params: { p: string; id: string } }>("/projects/:p/sources/:id/credentials", async (req) => {
    const { project } = requireProject(req, req.params.p, "admin");
    return credentialStatus(project.id, req.params.id);
  });

  app.delete<{ Params: { p: string; id: string; userId: string } }>("/projects/:p/sources/:id/credentials/:userId", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    await clearCredentials(project.id, req.params.id, req.params.userId);
    audit(project.id, user.id, "source.credentials.clear", req.params.id, { userId: req.params.userId });
    return { ok: true };
  });

  app.post<{ Params: { p: string; id: string } }>("/projects/:p/sources/:id/introspect", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "builder");
    instanceById(project.id, req.params.id);
    const snap = await introspectInstance(project.id, req.params.id, user.id);
    return { ok: true, tables: snap.schemas.reduce((n, s) => n + s.tables.length, 0), endpoints: snap.endpoints?.length ?? 0, capturedAt: snap.capturedAt };
  });

  app.get<{ Params: { p: string; id: string }; Querystring: { search?: string; format?: string } }>("/projects/:p/sources/:id/schema", async (req) => {
    const { project } = requireProject(req, req.params.p, "builder");
    instanceById(project.id, req.params.id);
    const s = schemaOf(req.params.id);
    if (req.query.format === "text") return { text: schemaText(s.snapshot, s.annotations, { search: req.query.search, maxChars: 200_000 }) };
    return s;
  });

  app.put<{ Params: { p: string; id: string } }>("/projects/:p/sources/:id/annotations", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "admin");
    instanceById(project.id, req.params.id);
    const a = annotationsSchema.parse(req.body) as Annotations;
    setAnnotations(req.params.id, a);
    audit(project.id, user.id, "source.annotate", req.params.id);
    return { ok: true };
  });

  /* ───────── queries ───────── */

  // viewers: run a dataset of a saved page version (the SQL comes from the server, only filter values from the client)
  app.post<{ Params: { p: string } }>("/projects/:p/query/dataset", async (req) => {
    requireScope(req, "query:read");
    const { project, user, role } = requireProject(req, req.params.p);
    const body = z.object({ pageId: z.string(), versionNo: z.number().int().optional(), datasetId: z.string(), filters: z.record(z.unknown()).default({}) }).parse(req.body);
    const page = loadPage(project.id, body.pageId, user, role);
    const v = getVersion(page.id, body.versionNo ?? page.current_version);
    const d = v.bundle.page.datasets.find((x) => x.id === body.datasetId);
    if (!d) throw notFound(`Dataset '${body.datasetId}' not found`);
    if (!d.source || !d.request) throw badRequest("Derived datasets are computed in the browser");
    return runQuery({
      projectId: project.id,
      userId: user.id,
      userEmail: user.email ?? user.login,
      alias: d.source,
      request: d.request,
      scope: { filters: body.filters, page: { id: page.id, title: v.bundle.page.title } },
      kind: "dataset",
      pageId: page.id,
      ttlSeconds: d.cache?.ttlSeconds ?? 60,
    });
  });

  // builders: run any read-only request (drafts, local pages, editor previews)
  app.post<{ Params: { p: string } }>("/projects/:p/query/adhoc", async (req) => {
    requireScope(req, "query:read");
    const { project, user } = requireProject(req, req.params.p, "builder");
    const body = z.object({ source: z.string(), request: z.record(z.unknown()), filters: z.record(z.unknown()).default({}), page: z.object({ id: z.string().optional(), title: z.string().optional() }).default({}), maxRows: z.number().int().positive().optional(), noCache: z.boolean().optional(), ttlSeconds: z.number().int().min(0).max(86400).optional() }).parse(req.body);
    return runQuery({
      projectId: project.id,
      userId: user.id,
      userEmail: user.email ?? user.login,
      alias: body.source,
      request: body.request,
      scope: { filters: body.filters, page: body.page },
      kind: "adhoc",
      limits: body.maxRows ? { maxRows: body.maxRows } : undefined,
      noCache: body.noCache,
      ttlSeconds: body.ttlSeconds,
    });
  });
}
