import { checkReadOnly, bindParams, type Dialect, type BoundQuery } from "@aibi/sql-guard";
import { inferType, type QueryResult, type Column } from "@aibi/transforms";
import type { QueryLimits, DatasourceInstance } from "./server";

export class QueryError extends Error {
  constructor(
    message: string,
    public code: "readonly" | "params" | "timeout" | "driver" | "limit" | "config" = "driver",
  ) {
    super(message);
  }
}

/** Convert driver values into JSON-safe values. */
export function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return `[binary ${v.length} bytes]`;
  if (v instanceof Uint8Array) return `[binary ${v.length} bytes]`;
  if (typeof v === "object") {
    // driver-specific wrappers (e.g. Oracle LOBs) are stringified defensively
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return String(v);
    }
  }
  return v;
}

/** Build a QueryResult from row objects, capping rows and bytes. */
export function buildResult(names: string[], rowObjects: Record<string, unknown>[] | unknown[][], limits: QueryLimits, started: number, typeHints?: Record<string, Column["type"]>): QueryResult {
  const rows: unknown[][] = [];
  let bytes = 0;
  let truncated = false;
  for (const r of rowObjects) {
    if (rows.length >= limits.maxRows) {
      truncated = true;
      break;
    }
    const arr = Array.isArray(r) ? r.map(normalizeValue) : names.map((n) => normalizeValue((r as Record<string, unknown>)[n]));
    bytes += JSON.stringify(arr).length;
    if (bytes > limits.maxBytes) {
      truncated = true;
      break;
    }
    rows.push(arr);
  }
  const columns: Column[] = names.map((name, i) => ({ name, type: typeHints?.[name] ?? inferType(rows.slice(0, 500).map((row) => row[i])) }));
  return { columns, rows, truncated, durationMs: Date.now() - started };
}

export interface SqlRequest {
  sql: string;
  params?: Record<string, unknown>;
}

/**
 * Validate a SQL request as read-only and bind its parameters.
 * Every SQL datasource must call this before touching the driver.
 */
export function prepareSql(
  dialect: Dialect,
  request: Record<string, unknown>,
  params: Record<string, unknown>,
  inst?: DatasourceInstance,
): BoundQuery {
  const sql = request.sql;
  if (typeof sql !== "string" || !sql.trim()) throw new QueryError("request.sql is required", "params");
  const cfg = inst?.config ?? {};
  const ro = checkReadOnly(sql, dialect, {
    deniedTables: (cfg.deniedTables as string[] | undefined) ?? [],
    allowedSchemas: (cfg.allowedSchemas as string[] | undefined)?.filter(Boolean),
  });
  if (!ro.ok) throw new QueryError(`Read-only check failed: ${ro.errors.join("; ")}`, "readonly");
  try {
    return bindParams(sql, params, dialect);
  } catch (e) {
    throw new QueryError((e as Error).message, "params");
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => {
        onTimeout?.();
        reject(new QueryError(`Query exceeded the ${Math.round(ms / 1000)}s time limit`, "timeout"));
      }, ms);
    }),
  ]);
}

/** Simple keyed pool registry so handlers can reuse pools per instance and close them on change. */
export class PoolRegistry<P> {
  private pools = new Map<string, { key: string; pool: P }>();
  constructor(private create: (cfg: Record<string, unknown>) => P | Promise<P>, private destroy: (p: P) => Promise<void> | void) {}
  async get(inst: DatasourceInstance): Promise<P> {
    const key = JSON.stringify(inst.config);
    const cur = this.pools.get(inst.id);
    if (cur && cur.key === key) return cur.pool;
    if (cur) await this.close(inst.id);
    const pool = await this.create(inst.config);
    this.pools.set(inst.id, { key, pool });
    return pool;
  }
  async close(id: string) {
    const cur = this.pools.get(id);
    if (!cur) return;
    this.pools.delete(id);
    try {
      await this.destroy(cur.pool);
    } catch {
      /* ignore */
    }
  }
  async closeAll() {
    for (const id of [...this.pools.keys()]) await this.close(id);
  }
}

export function cfgString(cfg: Record<string, unknown>, k: string, fallback?: string): string {
  const v = cfg[k];
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new QueryError(`config '${k}' is required`, "config");
  }
  return String(v);
}
export function cfgNumber(cfg: Record<string, unknown>, k: string, fallback: number): number {
  const v = Number(cfg[k]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
