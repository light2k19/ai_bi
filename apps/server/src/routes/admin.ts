import type { FastifyInstance } from "fastify";
import { all, get, parse } from "../db";
import { requireProject } from "../services/access";

/** The name behind an audit target id (pages keep their name after deletion), or the target itself. */
function targetName(target: string | null): string | null {
  if (!target) return null;
  const prefix = target.split("_")[0];
  const row =
    prefix === "pg" ? get<{ n: string }>("SELECT title AS n FROM pages WHERE id = ?", target)
    : prefix === "ds" ? get<{ n: string }>("SELECT name || ' (' || alias || ')' AS n FROM skill_instances WHERE id = ?", target)
    : prefix === "usr" ? get<{ n: string }>("SELECT COALESCE(display_name, login) AS n FROM users WHERE id = ?", target)
    : prefix === "prj" ? get<{ n: string }>("SELECT name AS n FROM projects WHERE id = ?", target)
    : prefix === "pkg" ? get<{ n: string }>("SELECT name AS n FROM packages WHERE id = ?", target)
    : null;
  return row?.n ?? target;
}

export async function adminRoutes(app: FastifyInstance) {
  app.get<{ Params: { p: string } }>("/projects/:p/usage", async (req) => {
    const { project } = requireProject(req, req.params.p, "admin");
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const ai = get<{ t: number; c: number; n: number }>(
      "SELECT COALESCE(SUM(prompt_tokens + completion_tokens),0) t, COALESCE(SUM(cost),0) c, COUNT(*) n FROM ai_usage WHERE project_id = ? AND created_at >= ?",
      project.id,
      monthStart.toISOString(),
    );
    const byDay = all<{ day: string; tokens: number; cost: number; calls: number }>(
      "SELECT substr(created_at,1,10) day, SUM(prompt_tokens + completion_tokens) tokens, SUM(cost) cost, COUNT(*) calls FROM ai_usage WHERE project_id = ? AND created_at >= date('now','-30 days') GROUP BY day ORDER BY day",
      project.id,
    );
    const byUser = all<{ email: string | null; tokens: number; cost: number }>(
      "SELECT COALESCE(u.display_name, u.login) AS email, SUM(prompt_tokens + completion_tokens) tokens, SUM(cost) cost FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id WHERE a.project_id = ? AND a.created_at >= ? GROUP BY a.user_id ORDER BY tokens DESC",
      project.id,
      monthStart.toISOString(),
    );
    const queries = get<{ n: number; errors: number; avg: number }>(
      "SELECT COUNT(*) n, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) errors, AVG(duration_ms) avg FROM query_log WHERE project_id = ? AND created_at >= ?",
      project.id,
      monthStart.toISOString(),
    );
    const settings = parse<{ ai?: { monthlyTokenBudget?: number; monthlyCostBudget?: number } }>(project.settings, {});
    return {
      month: { aiTokens: ai?.t ?? 0, aiCost: ai?.c ?? 0, aiCalls: ai?.n ?? 0, queries: queries?.n ?? 0, queryErrors: queries?.errors ?? 0, avgQueryMs: Math.round(queries?.avg ?? 0) },
      budgets: settings.ai ?? {},
      byDay,
      byUser,
      pages: get<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE project_id = ? AND deleted = 0", project.id)?.n ?? 0,
    };
  });

  app.get<{ Params: { p: string }; Querystring: { limit?: string } }>("/projects/:p/audit", async (req) => {
    const { project } = requireProject(req, req.params.p, "admin");
    return all<{ id: number; action: string; target: string | null; detail: string | null; created_at: string; email: string | null }>(
      "SELECT a.*, COALESCE(u.display_name, u.login) AS email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.project_id = ? ORDER BY a.id DESC LIMIT ?",
      project.id,
      Math.min(Number(req.query.limit ?? 200), 1000),
    ).map((a) => ({ id: a.id, action: a.action, target: a.target, targetName: targetName(a.target), detail: parse(a.detail, null), at: a.created_at, actor: a.email }));
  });

  app.get<{ Params: { p: string }; Querystring: { limit?: string; status?: string } }>("/projects/:p/query-log", async (req) => {
    const { project } = requireProject(req, req.params.p, "admin");
    return all<{ id: number; kind: string; request: string; duration_ms: number; rows: number; status: string; error: string | null; created_at: string; email: string | null; alias: string | null }>(
      `SELECT q.*, COALESCE(u.display_name, u.login) AS email, i.alias FROM query_log q LEFT JOIN users u ON u.id = q.user_id LEFT JOIN skill_instances i ON i.id = q.instance_id
       WHERE q.project_id = ? ${req.query.status ? "AND q.status = ?" : ""} ORDER BY q.id DESC LIMIT ?`,
      ...(req.query.status ? [project.id, req.query.status] : [project.id]),
      Math.min(Number(req.query.limit ?? 200), 1000),
    ).map((q) => ({ id: q.id, kind: q.kind, source: q.alias, request: parse(q.request, q.request), ms: q.duration_ms, rows: q.rows, status: q.status, error: q.error, at: q.created_at, user: q.email }));
  });
}
