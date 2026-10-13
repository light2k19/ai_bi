import {
  defineServerSkill,
  QueryError,
  cfgString,
  cfgNumber,
  buildUrl,
  authHeaders,
  safeHeaders,
  fetchJson,
  jsonToResult,
  type DatasourceInstance,
  type EndpointInfo,
} from "@aibi/skill-sdk";

// kept for existing imports and tests
export { buildUrl, selectPath } from "@aibi/skill-sdk";

async function call(inst: DatasourceInstance, request: Record<string, unknown>, timeoutMs: number, maxBytes: number) {
  const cfg = inst.config;
  const method = String(request.method ?? "GET").toUpperCase();
  if (method !== "GET" && !(method === "POST" && cfg.allowPost)) throw new QueryError(`method ${method} is not allowed for this data source`, "params");
  const url = buildUrl(cfgString(cfg, "baseUrl"), String(request.path ?? ""), request.query as Record<string, unknown> | undefined);
  const headers = safeHeaders({ ...((cfg.headers as Record<string, string>) ?? {}), ...(await authHeaders(cfg)) }, request.headers as Record<string, unknown> | undefined);
  return fetchJson(url, { method: method as "GET" | "POST", headers, body: request.body, timeoutMs, maxBytes });
}

export default defineServerSkill({
  datasource: {
    kind: "http",
    async testConnection(inst) {
      try {
        const base = new URL(cfgString(inst.config, "baseUrl"));
        await authHeaders(inst.config);
        const eps = (inst.config.endpoints as EndpointInfo[] | undefined) ?? [];
        if (eps[0] && (eps[0].method ?? "GET") === "GET") {
          await call(inst, { method: "GET", path: eps[0].path }, 15000, 5_000_000);
          return { ok: true, message: `Reached ${base.origin}; GET ${eps[0].path} returned JSON` };
        }
        return { ok: true, message: `Configuration is valid for ${base.origin}. Add an endpoint to test a real call.` };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async introspect(inst) {
      const endpoints: EndpointInfo[] = [...((inst.config.endpoints as EndpointInfo[] | undefined) ?? [])];
      if (inst.config.openApiUrl) {
        try {
          const doc = (await fetchJson(String(inst.config.openApiUrl), { headers: await authHeaders(inst.config), timeoutMs: 15000, maxBytes: 20_000_000 })) as {
            paths?: Record<string, Record<string, { summary?: string; description?: string; parameters?: { name: string; in: string; description?: string }[] }>>;
          };
          for (const [p, ops] of Object.entries(doc.paths ?? {})) {
            for (const [m, op] of Object.entries(ops)) {
              if (!["get", "post"].includes(m)) continue;
              endpoints.push({
                method: m.toUpperCase() as "GET" | "POST",
                path: p,
                description: op.summary ?? op.description,
                params: Object.fromEntries((op.parameters ?? []).filter((x) => x.in === "query").map((x) => [x.name, x.description ?? ""])),
              });
            }
          }
        } catch {
          /* OpenAPI is optional */
        }
      }
      return { schemas: [], endpoints: endpoints.slice(0, 300) };
    },
    async query(inst, request, _params, limits) {
      const started = Date.now();
      const timeoutMs = Math.min(limits.timeoutMs, cfgNumber(inst.config, "timeoutMs", limits.timeoutMs));
      const doc = await call(inst, request, timeoutMs, limits.maxBytes);
      return jsonToResult(doc, request.resultPath as string | undefined, limits, started);
    },
  },
});
