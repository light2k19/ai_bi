import type { FastifyInstance } from "fastify";
import { handleMcp } from "../services/mcp";
import { memberRole, findProject } from "../services/access";

export async function mcpRoute(app: FastifyInstance) {
  app.post("/mcp", async (req, reply) => {
    if (!req.user || !req.pat) return reply.code(401).header("WWW-Authenticate", 'Bearer realm="ai-bi"').send({ error: "Use a personal access token with the mcp scope" });
    if (!req.pat.scopes.includes("mcp")) return reply.code(403).send({ error: "This token lacks the mcp scope" });
    const projectId = req.pat.projectId ?? findProject(String(req.headers["x-aibi-project"] ?? ""))?.id;
    if (!projectId) return reply.code(400).send({ error: "The token is not bound to a project" });
    const role = memberRole(projectId, req.user);
    if (!role) return reply.code(403).send({ error: "Not a member of the project" });
    const result = await handleMcp(req.body, { projectId, user: req.user, role, scopes: req.pat.scopes });
    if (result === null || (Array.isArray(result) && !result.length)) return reply.code(202).send();
    return reply.type("application/json").send(result);
  });
  app.get("/mcp", async (_req, reply) => reply.code(405).header("Allow", "POST").send({ error: "Use POST (Streamable HTTP, JSON responses)" }));
}
