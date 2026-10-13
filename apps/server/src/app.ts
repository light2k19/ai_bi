import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { config } from "./config";
import { HttpError } from "./lib/errors";
import { authenticate } from "./services/access";
import { authRoutes } from "./routes/auth";
import { projectRoutes } from "./routes/projects";
import { sourceRoutes } from "./routes/sources";
import { pageRoutes } from "./routes/pages";
import { packageRoutes } from "./routes/packages";
import { moduleRoutes } from "./routes/modules";
import { aiRoutes } from "./routes/ai";
import { renderRoutes } from "./routes/render";
import { adminRoutes } from "./routes/admin";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 30 * 1024 * 1024, trustProxy: true, maxParamLength: 2000 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 60 * 1024 * 1024, files: 1 } });

  app.decorateRequest("user", null);
  app.decorateRequest("pat", null);

  app.addHook("onRequest", async (req, reply) => {
    // render endpoints are authenticated by a short-lived token in the URL (no cookies) and are called
    // by the standalone runtime on its own origin
    if (req.url.startsWith("/api/render/")) {
      reply.header("Access-Control-Allow-Origin", "*").header("Access-Control-Allow-Methods", "GET, POST").header("Access-Control-Allow-Headers", "content-type");
      if (req.method === "OPTIONS") {
        reply.code(204).send();
        return reply;
      }
      req.user = null;
      req.pat = null;
      return;
    }
    authenticate(req);
    // CSRF: cookie-authenticated state changes must come from the web origin
    if (!SAFE.has(req.method) && !req.pat && req.url.startsWith("/api/")) {
      const origin = req.headers.origin;
      const allowed = new Set([config.webOrigin, config.publicApiUrl, `http://${req.headers.host}`, `https://${req.headers.host}`]);
      if (origin && !allowed.has(origin)) {
        reply.code(403).send({ error: "Cross-origin request rejected" });
        return reply;
      }
      if (req.cookies?.aibi_session && !origin) {
        const ct = req.headers["content-type"] ?? "";
        if (!ct.startsWith("application/json") && !ct.startsWith("multipart/form-data")) {
          reply.code(403).send({ error: "Unsupported content type" });
          return reply;
        }
      }
    }
  });

  // security headers for the web app and the API (the runtime has its own, stricter policy)
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    if (req.url.startsWith("/api/") || req.url.startsWith("/mcp")) {
      if (!reply.getHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
    } else {
      reply.header("X-Frame-Options", "DENY");
      reply.header("Content-Security-Policy", webCsp());
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    console.error(err);
    return reply.code(500).send({ error: "Internal error", details: process.env.NODE_ENV === "production" ? undefined : err.message });
  });

  await app.register(
    async (api) => {
      await authRoutes(api);
      await projectRoutes(api);
      await sourceRoutes(api);
      await pageRoutes(api);
      await packageRoutes(api);
      await moduleRoutes(api);
      await aiRoutes(api);
      await renderRoutes(api);
      await adminRoutes(api);
    },
    { prefix: "/api" },
  );
  // MCP endpoint at the root (clients are configured with <server>/mcp)
  const { mcpRoute } = await import("./routes/mcp");
  await mcpRoute(app);

  // production: serve the built web app with SPA fallback
  if (fs.existsSync(path.join(config.webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: "/", wildcard: false });
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/mcp")) return reply.code(404).send({ error: "Not found" });
      return reply.type("text/html").send(fs.readFileSync(path.join(config.webDist, "index.html")));
    });
  }
  return app;
}

/** CSP of the web app: its own code only, the page runtime in a frame, and no embedding anywhere. */
export function webCsp(): string {
  const rt = new URL(config.runtimeOrigin).origin;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' blob: ${rt}`,
    `frame-src ${rt}`,
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** The runtime must live on its own origin: a second listener serving the built runtime with a strict CSP. */
export async function buildRuntimeServer(): Promise<FastifyInstance | null> {
  if (!config.runtimePort || !fs.existsSync(path.join(config.runtimeDist, "index.html"))) return null;
  const rt = Fastify({ logger: false });
  rt.addHook("onSend", async (_req, reply) => {
    reply.header("Content-Security-Policy", runtimeCsp());
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });
  await rt.register(fastifyStatic, { root: config.runtimeDist, prefix: "/" });
  return rt;
}

export function runtimeCsp(): string {
  // the public API origin, plus the server's own address to it for PDF export and preview screenshots
  const api = [...new Set([new URL(config.publicApiUrl).origin, new URL(config.internalApiUrl).origin])].join(" ");
  // modules are vendored server-side and served from the API by hash: page code never loads from a CDN
  return [
    "default-src 'self'",
    `script-src 'self' blob: ${api}`,
    `connect-src 'self' blob: ${api}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "frame-src https:",
    `frame-ancestors ${config.webOrigin} ${new URL(config.publicApiUrl).origin}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}
