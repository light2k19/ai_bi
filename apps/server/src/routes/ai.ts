import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireProject } from "../services/access";
import { runBuildTurn, listSessions, sessionTranscript, type ChatEvent } from "../ai/orchestrator";
import { askAboutPage } from "../ai/ask";
import { browserAvailable, screenshotDraft } from "../services/render";
import { HttpError } from "../lib/errors";

/** Open a Server-Sent Events stream; returns a writer and an abort signal tied to the client connection. */
function sse(req: FastifyRequest, reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const ctrl = new AbortController();
  let closed = false;
  // the response closes when the client goes away (the request stream closes as soon as the body is read)
  reply.raw.on("close", () => {
    closed = true;
    ctrl.abort();
  });
  const ping = setInterval(() => !closed && reply.raw.write(": ping\n\n"), 15_000);
  return {
    signal: ctrl.signal,
    send(e: unknown) {
      if (!closed) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    },
    end() {
      clearInterval(ping);
      if (!closed) reply.raw.end();
    },
  };
}

const datasetSample = z.object({
  id: z.string(),
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(z.record(z.unknown())).max(500),
  totalRows: z.number().optional(),
});

export async function aiRoutes(app: FastifyInstance) {
  /* builder agent: one turn, streamed */
  app.post<{ Params: { p: string } }>("/projects/:p/ai/chat", async (req, reply) => {
    const { project, user, role } = requireProject(req, req.params.p, "builder");
    const body = z.object({ message: z.string().min(1).max(20_000), draft: z.unknown(), sessionId: z.string().optional(), pageId: z.string().optional() }).parse(req.body);
    const stream = sse(req, reply);
    try {
      await runBuildTurn({
        projectId: project.id,
        user,
        role,
        sessionId: body.sessionId,
        pageId: body.pageId,
        message: body.message,
        draft: body.draft as never,
        emit: (e: ChatEvent) => stream.send(e),
        signal: stream.signal,
        renderPreview: browserAvailable() ? (draft) => screenshotDraft(project.id, user, draft) : undefined,
      });
    } catch (e) {
      stream.send({ type: "error", message: e instanceof HttpError ? e.message : (e as Error).message });
    } finally {
      stream.end();
    }
  });

  app.get<{ Params: { p: string }; Querystring: { pageId?: string } }>("/projects/:p/ai/sessions", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "builder");
    return listSessions(project.id, user.id, req.query.pageId);
  });

  app.get<{ Params: { p: string; id: string } }>("/projects/:p/ai/sessions/:id", async (req) => {
    const { project, user } = requireProject(req, req.params.p, "builder");
    return sessionTranscript(project.id, user.id, req.params.id);
  });

  /* runtime AI: viewers ask about the page they see (streamed) */
  app.post<{ Params: { p: string } }>("/projects/:p/ai/ask", async (req, reply) => {
    const { project, user, role } = requireProject(req, req.params.p);
    const body = z
      .object({
        question: z.string().min(1).max(4000),
        page: z.object({ title: z.string(), description: z.string().optional(), filters: z.record(z.unknown()).optional() }).optional(),
        bundle: z.unknown().optional(),
        datasets: z.array(datasetSample).max(20).default([]),
        widget: z.object({ id: z.string(), type: z.string(), title: z.string().optional(), props: z.record(z.unknown()).optional() }).optional(),
        history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).max(20).optional(),
      })
      .parse(req.body);
    const stream = sse(req, reply);
    try {
      const r = await askAboutPage({ projectId: project.id, user, role, ...body, onText: (d) => stream.send({ type: "text", delta: d }), signal: stream.signal });
      stream.send({ type: "done", text: r.text, cached: r.cached });
    } catch (e) {
      stream.send({ type: "error", message: (e as Error).message });
    } finally {
      stream.end();
    }
  });

  /* narrative widgets: cached commentary per data + filter state */
  app.post<{ Params: { p: string } }>("/projects/:p/ai/narrative", async (req) => {
    const { project, user, role } = requireProject(req, req.params.p);
    const body = z
      .object({
        pageId: z.string(),
        widgetId: z.string(),
        prompt: z.string().min(1).max(4000),
        maxWords: z.number().int().min(10).max(1000).optional(),
        page: z.object({ title: z.string(), description: z.string().optional(), filters: z.record(z.unknown()).optional() }).optional(),
        datasets: z.array(datasetSample).max(10),
        refresh: z.boolean().optional(),
      })
      .parse(req.body);
    const r = await askAboutPage({
      projectId: project.id,
      user,
      role: role === "viewer" ? "viewer" : role,
      question: body.prompt,
      page: body.page,
      datasets: body.datasets,
      maxWords: body.maxWords ?? 150,
      cacheKey: `${body.pageId}:${body.widgetId}`,
      pageId: body.pageId,
      refresh: body.refresh,
    });
    return r;
  });
}
