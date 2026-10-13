/**
 * Helpers for API data source skills: safe URL building, auth headers, bounded JSON fetching,
 * JSON-path selection and turning JSON records into rows. Every API skill should use these so the
 * read-only and isolation rules are applied the same way everywhere.
 */
import { QueryError, cfgString, buildResult } from "./sql";
import type { QueryLimits } from "./server";
import type { QueryResult } from "@aibi/transforms";

/* ───────── URLs ───────── */

/** Resolve a path relative to baseUrl and refuse anything that leaves it (other hosts, `..`). */
export function buildUrl(baseUrl: string, path: string, query?: Record<string, unknown>): URL {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) throw new QueryError("request.path must be relative to the base URL", "params");
  const base = endpointUrl({ baseUrl }, "baseUrl");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const url = new URL(path.replace(/^\/+/, ""), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new QueryError("request.path escapes the base URL", "params");
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  return url;
}

/**
 * The configured URL of a fixed endpoint (GraphQL, OData service root, SQL-over-HTTP), exactly as
 * configured (no trailing slash added). Only http and https are accepted.
 */
export function endpointUrl(cfg: Record<string, unknown>, key = "baseUrl"): URL {
  let u: URL;
  try {
    u = new URL(cfgString(cfg, key));
  } catch (e) {
    if (e instanceof QueryError) throw e;
    throw new QueryError(`config '${key}' is not a valid URL`, "config");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new QueryError(`config '${key}' must be an http(s) URL`, "config");
  return u;
}

/* ───────── auth ───────── */

/**
 * Standard auth config keys (copy into your configSchema.properties and list AUTH_SECRETS in "secrets"):
 *   authType: none | bearer | basic | header | oauth2_client_credentials   (default none)
 *   token (secret) · username · headerName · tokenUrl · clientId · clientSecret (secret) · scope
 */
export const AUTH_CONFIG_SCHEMA = {
  authType: { type: "string", title: "Auth", enum: ["none", "bearer", "basic", "header", "oauth2_client_credentials"], default: "none" },
  token: { type: "string", title: "Bearer token / header value / basic password", format: "password" },
  username: { type: "string", title: "Basic auth user" },
  headerName: { type: "string", title: "Auth header name (for header auth)", default: "X-API-Key" },
  tokenUrl: { type: "string", title: "OAuth2 token URL" },
  clientId: { type: "string", title: "OAuth2 client id" },
  clientSecret: { type: "string", title: "OAuth2 client secret", format: "password" },
  scope: { type: "string", title: "OAuth2 scope" },
} as const;
export const AUTH_SECRETS = ["token", "clientSecret"];

const tokenCache = new Map<string, { token: string; expires: number }>();

/**
 * Auth headers from the standard auth keys. Missing authType = none; an unknown authType is a config
 * error. OAuth2 tokens are fetched with a 15 s timeout, no redirects, and cached until shortly before expiry.
 */
export async function authHeaders(cfg: Record<string, unknown>): Promise<Record<string, string>> {
  const h: Record<string, string> = {};
  const type = cfg.authType === undefined || cfg.authType === "" ? "none" : String(cfg.authType);
  switch (type) {
    case "none":
      break;
    case "bearer":
      h.Authorization = `Bearer ${cfgString(cfg, "token")}`;
      break;
    case "basic":
      h.Authorization = `Basic ${Buffer.from(`${cfgString(cfg, "username")}:${cfgString(cfg, "token", "")}`).toString("base64")}`;
      break;
    case "header":
      h[cfgString(cfg, "headerName", "X-API-Key")] = cfgString(cfg, "token");
      break;
    case "oauth2_client_credentials": {
      const key = `${cfg.tokenUrl}|${cfg.clientId}|${cfg.scope ?? ""}`;
      const cached = tokenCache.get(key);
      if (cached && cached.expires > Date.now() + 30_000) {
        h.Authorization = `Bearer ${cached.token}`;
        break;
      }
      const body = new URLSearchParams({ grant_type: "client_credentials", client_id: cfgString(cfg, "clientId"), client_secret: cfgString(cfg, "clientSecret") });
      if (cfg.scope) body.set("scope", String(cfg.scope));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      let j: { access_token?: string; expires_in?: number };
      try {
        const r = await fetch(endpointUrl(cfg, "tokenUrl"), { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, redirect: "manual", signal: ctrl.signal });
        if (!r.ok) throw new QueryError(`OAuth2 token request failed: HTTP ${r.status}`, "config");
        j = (await r.json()) as typeof j;
      } catch (e) {
        if (e instanceof QueryError) throw e;
        throw new QueryError(`OAuth2 token request failed: ${(e as Error).name === "AbortError" ? "timed out" : (e as Error).message}`, "config");
      } finally {
        clearTimeout(timer);
      }
      if (!j.access_token) throw new QueryError("OAuth2 token response has no access_token", "config");
      tokenCache.set(key, { token: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 });
      h.Authorization = `Bearer ${j.access_token}`;
      break;
    }
    default:
      throw new QueryError(`unknown authType '${type}'`, "config");
  }
  return h;
}

/** Merge page-supplied headers without letting them override auth, cookies, the host or configured headers. */
export function safeHeaders(base: Record<string, string>, extra?: Record<string, unknown>): Record<string, string> {
  const out = { ...base };
  const lower = new Set(Object.keys(out).map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (/^(authorization|cookie|host|proxy-authorization)$/i.test(k) || lower.has(k.toLowerCase())) continue;
    out[k] = String(v);
  }
  return out;
}

/* ───────── fetching ───────── */

export interface FetchJsonOptions {
  /** GET (default) or POST */
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** a JS value; fetchJson encodes it as JSON and sets content-type for POST (do not pre-encode) */
  body?: unknown;
  timeoutMs: number;
  maxBytes: number;
  /** retry once on HTTP 429, waiting Retry-After (max 5 s) when it fits in the time budget; default true */
  retry429?: boolean;
}

/** A non-2xx response. `body` is the response text (truncated to 64 KB), `json` the parsed body when it is JSON. */
export class HttpStatusError extends QueryError {
  constructor(
    public status: number,
    public body: string,
    public headers: Headers,
    public json: unknown,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`, "driver");
  }
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)}s`);

/** Read a response body as text, failing as soon as it exceeds maxBytes (real bytes, not characters). */
async function readCapped(r: Response, maxBytes: number): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new QueryError(`response is larger than ${maxBytes} bytes`, "limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Fetch JSON with a timeout and a size cap and return the parsed body plus status and headers.
 * Never follows redirects. Errors are QueryErrors; non-2xx responses are HttpStatusError (with status,
 * body, headers and parsed json). Error texts: "HTTP <status>: …", "redirects are not followed",
 * "response is larger than N bytes", "request exceeded the N time limit", "response is not JSON".
 */
export async function fetchJsonWithMeta(url: URL | string, o: FetchJsonOptions): Promise<{ data: unknown; status: number; headers: Headers }> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const remaining = o.timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new QueryError(`request exceeded the ${seconds(o.timeoutMs)} time limit`, "timeout");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      const r = await fetch(url, {
        method: o.method ?? "GET",
        headers: { accept: "application/json", ...(o.method === "POST" ? { "content-type": "application/json" } : {}), ...(o.headers ?? {}) },
        body: o.method === "POST" ? JSON.stringify(o.body ?? {}) : undefined,
        redirect: "manual",
        signal: ctrl.signal,
      });
      if (r.status >= 300 && r.status < 400) throw new QueryError("redirects are not followed", "driver");
      if (r.status === 429 && attempt === 0 && o.retry429 !== false) {
        const ra = Number(r.headers.get("retry-after"));
        const wait = Math.min(5000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000);
        await r.body?.cancel().catch(() => undefined);
        if (Date.now() - started + wait < o.timeoutMs) {
          clearTimeout(timer);
          await new Promise((res) => setTimeout(res, wait));
          continue;
        }
      }
      const text = await readCapped(r, o.maxBytes);
      let data: unknown;
      let parsed = true;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        parsed = false;
      }
      if (!r.ok) throw new HttpStatusError(r.status, text.slice(0, 65_536), r.headers, parsed ? data : undefined);
      if (!parsed) throw new QueryError("response is not JSON", "driver");
      return { data, status: r.status, headers: r.headers };
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new QueryError(`request exceeded the ${seconds(o.timeoutMs)} time limit`, "timeout");
      throw e instanceof QueryError ? e : new QueryError((e as Error).message, "driver");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** fetchJsonWithMeta, returning only the parsed body. */
export async function fetchJson(url: URL | string, o: FetchJsonOptions): Promise<unknown> {
  return (await fetchJsonWithMeta(url, o)).data;
}

/* ───────── JSON → rows ───────── */

/** Minimal JSONPath: $, .key, [n], ['key'], [*] */
export function selectPath(doc: unknown, path: string | undefined): unknown {
  if (!path || path === "$") return doc;
  const tokens = path.replace(/^\$\.?/, "").match(/[^.[\]'"]+|\[\d+\]|\[\*\]/g) ?? [];
  let cur: unknown = doc;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (t === "[*]") continue;
    const idx = /^\[(\d+)\]$/.exec(t);
    if (idx) cur = (cur as unknown[])[Number(idx[1])];
    else cur = (cur as Record<string, unknown>)[t];
  }
  return cur;
}

/** Flatten nested objects into dotted keys (customer.name); arrays become JSON text. */
export function flattenRecord(o: unknown, prefix = "", out: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  if (o && typeof o === "object" && !Array.isArray(o) && depth < 3) {
    for (const [k, v] of Object.entries(o)) flattenRecord(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else out[prefix || "value"] = Array.isArray(o) ? JSON.stringify(o) : o;
  return out;
}

/**
 * Turn a JSON document into a QueryResult: select the records with `resultPath`, flatten them,
 * union their keys into columns, and apply the row and byte limits.
 */
export function jsonToResult(doc: unknown, resultPath: string | undefined, limits: QueryLimits, started: number): QueryResult {
  let data = selectPath(doc, resultPath);
  if (data && !Array.isArray(data) && typeof data === "object") data = [data];
  if (!Array.isArray(data)) throw new QueryError(`resultPath '${resultPath ?? "$"}' did not select an array or object`, "params");
  const rows = data.map((x) => flattenRecord(x));
  const names = [...new Set(rows.slice(0, 500).flatMap((r) => Object.keys(r)))];
  return buildResult(names, rows, limits, started);
}
