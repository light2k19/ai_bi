import { resolveBindings, bindingFormatters, bindingsInCodeFields } from "@aibi/page-spec";
import { QueryError, type QueryLimits } from "@aibi/skill-sdk";
import type { QueryResult } from "@aibi/transforms";
import { get, run, now, json } from "../db";
import { config } from "../config";
import { TtlCache, RateLimiter } from "../lib/cache";
import { HttpError, tooMany, badRequest } from "../lib/errors";
import { sha256 } from "../lib/crypto";
import { datasourceHandler, enabledSkills, getSkill, projectSettings } from "../skills/registry";
import { runtimeInstance, connectionOverrides, overrideMessage, type InstanceRow } from "./sources";

const cache = new TtlCache<QueryResult>(1000);
const limiter = new RateLimiter();

export function invalidateInstanceCache(instanceId: string) {
  cache.deletePrefix(`${instanceId}|`);
}

export interface QueryOptions {
  projectId: string;
  userId: string;
  userEmail?: string;
  alias: string;
  /** request with {{ }} bindings */
  request: Record<string, unknown>;
  /** binding scope: filters (runtime values), page */
  scope?: Record<string, unknown>;
  kind: "dataset" | "adhoc" | "preview" | "ai" | "export";
  pageId?: string;
  ttlSeconds?: number;
  limits?: Partial<QueryLimits>;
  noCache?: boolean;
}

export function projectLimits(projectId: string): QueryLimits {
  const s = (projectSettings(projectId).limits ?? {}) as Partial<QueryLimits>;
  return {
    maxRows: Math.min(s.maxRows ?? config.limits.maxRows, 200_000),
    timeoutMs: Math.min(s.timeoutMs ?? config.limits.timeoutMs, 300_000),
    maxBytes: Math.min(s.maxBytes ?? config.limits.maxBytes, 200_000_000),
  };
}

/** Resolve bindings and split a request into the request object and SQL params. */
export function resolveRequest(request: Record<string, unknown>, scope: Record<string, unknown>) {
  // filter values are viewer-controlled: never interpolate them into query code
  const unsafe = bindingsInCodeFields(request);
  if (unsafe.length) throw badRequest(`{{ }} bindings are not allowed inside ${unsafe.join(", ")}; use bound parameters, query parameters or variables`);
  try {
    const resolved = resolveBindings(request, scope, bindingFormatters());
    const params = (resolved.params as Record<string, unknown> | undefined) ?? {};
    return { resolved, params };
  } catch (e) {
    throw badRequest(`Could not resolve bindings: ${(e as Error).message}`);
  }
}

export async function runQuery(o: QueryOptions): Promise<QueryResult> {
  if (!limiter.check(`q:${o.userId}`, config.limits.queriesPerMinute)) throw tooMany("Query rate limit reached; try again in a minute");
  const inst = get<InstanceRow>("SELECT * FROM skill_instances WHERE project_id = ? AND alias = ?", o.projectId, o.alias);
  if (!inst) throw badRequest(`No data source '${o.alias}' in this project`);
  if (inst.status === "disabled") throw badRequest(`Data source '${o.alias}' is disabled`);
  if (!enabledSkills(o.projectId).some((s) => s.manifest.id === inst.skill_id)) throw badRequest(`The '${inst.skill_id}' skill is disabled in this project`);

  const overrides = connectionOverrides(inst.skill_id, o.request);
  if (overrides.length) throw badRequest(overrideMessage(inst.alias, overrides));
  const scope = { filters: {}, page: {}, ...(o.scope ?? {}), user: { id: o.userId, email: o.userEmail ?? "" } };
  const { resolved, params } = resolveRequest(o.request, scope);
  const base = projectLimits(o.projectId);
  const limits: QueryLimits = {
    maxRows: Math.min(o.limits?.maxRows ?? base.maxRows, base.maxRows),
    timeoutMs: Math.min(o.limits?.timeoutMs ?? base.timeoutMs, base.timeoutMs),
    maxBytes: Math.min(o.limits?.maxBytes ?? base.maxBytes, base.maxBytes),
  };
  // the skill version is part of the key: an upgraded skill never serves results cached by the old one
  // per-user sign-in: results are cached per user, never shared between accounts
  const who = inst.credential_mode === "user" ? `u:${o.userId}` : "shared";
  const key = `${inst.id}|${who}|${inst.updated_at}|${getSkill(inst.skill_id)?.manifest.version ?? "?"}|${sha256(json({ r: resolved, p: params, l: limits }))}`;
  const ttl = (o.ttlSeconds ?? 60) * 1000;
  if (!o.noCache && ttl > 0) {
    const hit = cache.get(key);
    if (hit) {
      log(o, inst.id, resolved, hit.durationMs ?? 0, hit.rows.length, "cached");
      return { ...hit, cached: true };
    }
  }
  const started = Date.now();
  try {
    const handler = datasourceHandler(inst.skill_id);
    const result = await handler.query(runtimeInstance(inst, o.userId), resolved, params, limits);
    if (!o.noCache && ttl > 0) cache.set(key, result, ttl);
    log(o, inst.id, resolved, Date.now() - started, result.rows.length, result.truncated ? "truncated" : "ok");
    return result;
  } catch (e) {
    const msg = (e as Error).message;
    log(o, inst.id, resolved, Date.now() - started, 0, "error", msg);
    if (e instanceof QueryError) throw new HttpError(e.code === "timeout" ? 504 : 400, msg, { code: e.code });
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Data source error: ${msg}`);
  }
}

function log(o: QueryOptions, instanceId: string, request: unknown, ms: number, rows: number, status: string, error?: string) {
  try {
    run(
      "INSERT INTO query_log (project_id, instance_id, user_id, page_id, kind, request, duration_ms, rows, status, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      o.projectId, instanceId, o.userId, o.pageId ?? null, o.kind, json(request).slice(0, 4000), ms, rows, status, error ?? null, now(),
    );
  } catch {
    /* logging must never fail a query */
  }
}

export async function explainQuery(projectId: string, alias: string, request: Record<string, unknown>, scope: Record<string, unknown>, userId?: string | null) {
  const inst = get<InstanceRow>("SELECT * FROM skill_instances WHERE project_id = ? AND alias = ?", projectId, alias);
  if (!inst) throw badRequest(`No data source '${alias}'`);
  if (inst.status === "disabled") throw badRequest(`Data source '${alias}' is disabled`);
  if (!enabledSkills(projectId).some((s) => s.manifest.id === inst.skill_id)) throw badRequest(`The '${inst.skill_id}' skill is disabled in this project`);
  const overrides = connectionOverrides(inst.skill_id, request);
  if (overrides.length) throw badRequest(overrideMessage(inst.alias, overrides));
  const handler = datasourceHandler(inst.skill_id);
  if (!handler.explain) return "This data source does not support EXPLAIN.";
  const { resolved, params } = resolveRequest(request, { filters: {}, page: {}, ...scope });
  try {
    return await handler.explain(runtimeInstance(inst, userId), resolved, params);
  } catch (e) {
    return `EXPLAIN failed: ${(e as Error).message}`;
  }
}
