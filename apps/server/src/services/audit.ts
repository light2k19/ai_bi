import { run, now, json } from "../db";

export function audit(projectId: string | null, actorId: string | null, action: string, target?: string, detail?: unknown) {
  run("INSERT INTO audit_log (project_id, actor_id, action, target, detail, created_at) VALUES (?,?,?,?,?,?)", projectId, actorId, action, target ?? null, detail === undefined ? null : json(detail), now());
}
