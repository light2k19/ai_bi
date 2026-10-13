import pg from "pg";
import Cursor from "pg-cursor";
import {
  defineServerSkill, prepareSql, buildResult, QueryError, PoolRegistry, cfgString, cfgNumber, withTimeout,
  type DatasourceInstance, type SchemaSnapshot, type TableInfo, type Column,
} from "@aibi/skill-sdk";

const DIALECT = "postgres" as const;
const MAX_TABLES = 1000;

/* ───────────── type parsing ───────────── */

// OIDs from pg_type
const OID = {
  int8: 20, int2: 21, int4: 23, oid: 26, float4: 700, float8: 701, money: 790, numeric: 1700,
  bool: 16, json: 114, jsonb: 3802,
  date: 1082, timestamp: 1114, timestamptz: 1184,
} as const;

/** Per-query type parsers: numbers as numbers, dates without timezone shifts. */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    switch (oid) {
      case OID.int8:
        return (v: string) => BigInt(v); // buildResult turns safe bigints into numbers, others into strings
      case OID.numeric:
        return (v: string) => {
          const n = Number(v);
          return Number.isFinite(n) ? n : v; // NaN / Infinity stay strings
        };
      case OID.date:
        return (v: string) => v; // keep 'YYYY-MM-DD'; parsing as a local Date could shift the day
      case OID.timestamp:
        return (v: string) => (/^\d{4}-\d\d-\d\d \d/.test(v) ? v.replace(" ", "T") : v); // wall-clock time, no zone
      default:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return pg.types.getTypeParser(oid, (format ?? "text") as any);
    }
  },
};

function typeHint(oid: number): Column["type"] | undefined {
  switch (oid) {
    case OID.int2: case OID.int4: case OID.int8: case OID.oid: case OID.float4: case OID.float8: case OID.numeric:
      return "number";
    case OID.bool:
      return "boolean";
    case OID.date: case OID.timestamp: case OID.timestamptz:
      return "date";
    case OID.json: case OID.jsonb:
      return "json";
    default:
      return undefined;
  }
}

/* ───────────── pools ───────────── */

const pools = new PoolRegistry<pg.Pool>(
  (cfg) => {
    const pool = new pg.Pool({
      host: cfgString(cfg, "host"),
      port: cfgNumber(cfg, "port", 5432),
      database: cfgString(cfg, "database"),
      user: cfgString(cfg, "user"),
      password: cfg.password ? String(cfg.password) : undefined,
      ssl: cfg.ssl ? { rejectUnauthorized: cfg.sslRejectUnauthorized !== false } : false,
      max: 4,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 15_000,
      application_name: "aibi",
    });
    // An idle client that loses its connection emits 'error' on the pool; without a listener the process crashes.
    pool.on("error", () => { /* the client is discarded by the pool */ });
    return pool;
  },
  (pool) => pool.end(),
);

/* ───────────── execution ───────────── */

interface RawResult {
  names: string[];
  oids: number[];
  rows: unknown[][];
}

function readCursor(cursor: Cursor<unknown[]>, n: number): Promise<{ rows: unknown[][]; fields: { name: string; dataTypeID: number }[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(n, (err, rows, result) => {
      if (err) reject(err);
      else resolve({ rows, fields: result?.fields ?? [] });
    });
  });
}

function isTimeout(e: unknown): boolean {
  return (e as { code?: string })?.code === "57014"; // query_canceled (statement_timeout)
}

/** Strip anything that could carry the password from driver error messages. */
function safeMessage(e: unknown, inst: DatasourceInstance): string {
  let msg = e instanceof Error ? e.message : String(e);
  const pw = inst.config.password;
  if (typeof pw === "string" && pw.length > 0) msg = msg.split(pw).join("***");
  return msg || "PostgreSQL error";
}

/** Run one statement in a read-only transaction that is always rolled back; return ≤ maxRows+1 rows. */
async function runReadOnly(inst: DatasourceInstance, sql: string, values: unknown[], maxRows: number, timeoutMs: number): Promise<RawResult> {
  const pool = await pools.get(inst);
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (e) {
    throw new QueryError(safeMessage(e, inst), "driver");
  }
  let discard = false;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
    // Extended protocol (one statement only), portal-based fetch of at most maxRows + 1 rows.
    const cursor = client.query(new Cursor<unknown[]>(sql, values, { rowMode: "array", types }));
    // Safety net if the server never answers (network stall): the statement timeout should fire first.
    const { rows, fields } = await withTimeout(readCursor(cursor, maxRows + 1), timeoutMs + 5000, () => {
      discard = true;
    });
    if (rows.length > maxRows) {
      // Stopped early: close the portal so no unread results stay on the connection.
      try {
        await cursor.close();
      } catch {
        discard = true;
      }
    }
    return { names: fields.map((f) => f.name), oids: fields.map((f) => f.dataTypeID), rows };
  } catch (e) {
    if (e instanceof QueryError) throw e;
    if (isTimeout(e)) throw new QueryError(`Query exceeded the ${Math.round(timeoutMs / 1000)}s time limit`, "timeout");
    throw new QueryError(safeMessage(e, inst), "driver");
  } finally {
    if (!discard) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    client.release(discard ? true : undefined); // release(true) destroys the connection
  }
}

/** Internal catalog query (trusted SQL, not from a page or the AI) returning row objects. */
async function catalog(inst: DatasourceInstance, sql: string, values: unknown[] = [], maxRows = 200_000): Promise<Record<string, unknown>[]> {
  const { names, rows } = await runReadOnly(inst, sql, values, maxRows, 30_000);
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function toNum(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/* ───────────── catalog SQL ───────────── */

const SQL_INFO = `
SELECT version() AS version,
       current_setting('server_version') AS server_version,
       current_user AS usr,
       current_database() AS db,
       r.rolsuper OR r.rolcreaterole OR r.rolcreatedb AS admin_role,
       has_database_privilege(current_database(), 'CREATE') AS db_create,
       EXISTS (
         SELECT 1 FROM pg_namespace n
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
           AND has_schema_privilege(n.oid, 'CREATE')
       ) AS schema_create,
       EXISTS (
         SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
           AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
             OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))
       ) AS table_write
FROM pg_roles r WHERE r.rolname = current_user`;

const SQL_TABLES = `
SELECT n.nspname AS schema, c.relname AS name, c.relkind AS relkind, c.oid::int8 AS oid,
       c.reltuples::float8 AS reltuples, obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND NOT c.relispartition
  AND has_table_privilege(c.oid, 'SELECT')
ORDER BY n.nspname, c.relname`;

const SQL_COLUMNS = `
SELECT a.attrelid::int8 AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
       NOT a.attnotnull AS nullable, col_description(a.attrelid, a.attnum) AS comment,
       EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
FROM pg_attribute a
WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attrelid, a.attnum`;

const SQL_FKS = `
SELECT con.conrelid::int8 AS oid, con.conname AS name, rn.nspname AS ref_schema, rc.relname AS ref_table,
       array_agg(la.attname::text ORDER BY k.ord) AS cols, array_agg(ra.attname::text ORDER BY k.ord) AS ref_cols
FROM pg_constraint con
JOIN pg_class rc ON rc.oid = con.confrelid
JOIN pg_namespace rn ON rn.oid = rc.relnamespace
CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(lnum, rnum, ord)
JOIN pg_attribute la ON la.attrelid = con.conrelid AND la.attnum = k.lnum
JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.rnum
WHERE con.contype = 'f' AND con.conrelid = ANY($1::oid[])
GROUP BY con.conrelid, con.conname, rn.nspname, rc.relname
ORDER BY con.conrelid, con.conname`;

/* ───────────── handler ───────────── */

export default defineServerSkill({
  datasource: {
    kind: "sql",
    dialect: DIALECT,

    async testConnection(inst) {
      try {
        const [info] = await catalog(inst, SQL_INFO, [], 1);
        if (!info) throw new Error("Could not read the current role from pg_roles");
        const canWrite = Boolean(info.admin_role || info.db_create || info.schema_create || info.table_write);
        const version = `PostgreSQL ${String(info.server_version)}`;
        return {
          ok: true,
          message:
            `Connected to ${version} as ${String(info.usr)}, database ${String(info.db)}` +
            (canWrite ? ". WARNING: the account can write; use a SELECT-only account." : ". Account is read-only."),
          details: {
            version: String(info.version),
            user: String(info.usr),
            database: String(info.db),
            writePrivileges: canWrite,
            superuserOrCreateRole: Boolean(info.admin_role),
            canCreateInDatabase: Boolean(info.db_create),
            canCreateInSchema: Boolean(info.schema_create),
            canWriteTables: Boolean(info.table_write),
          },
        };
      } catch (e) {
        return { ok: false, message: safeMessage(e, inst) };
      }
    },

    async introspect(inst) {
      const [{ current_schema: cur } = { current_schema: "public" }] = await catalog(inst, "SELECT current_schema() AS current_schema", [], 1);
      const defaultSchema = cur ? String(cur) : "public";
      const allowed = strList(inst.config.allowedSchemas);
      const schemaNames = allowed.length ? allowed : [defaultSchema];
      const denied = new Set(strList(inst.config.deniedTables).map((t) => t.toLowerCase()));
      const isDenied = (schema: string, table: string) =>
        denied.has(table.toLowerCase()) || denied.has(`${schema}.${table}`.toLowerCase());

      const tableRows = (await catalog(inst, SQL_TABLES, [schemaNames]))
        .filter((t) => !isDenied(String(t.schema), String(t.name)))
        .slice(0, MAX_TABLES);

      const byOid = new Map<string, { schema: string; info: TableInfo }>();
      for (const t of tableRows) {
        const rel = String(t.relkind);
        const est = toNum(t.reltuples);
        const info: TableInfo = {
          name: String(t.name),
          kind: rel === "v" || rel === "m" ? "view" : "table",
          columns: [],
        };
        if (est !== undefined && est >= 0 && rel !== "v") info.rowEstimate = Math.round(est);
        if (t.comment) info.comment = String(t.comment);
        byOid.set(String(t.oid), { schema: String(t.schema), info });
      }

      const oids = [...byOid.keys()];
      if (oids.length) {
        for (const c of await catalog(inst, SQL_COLUMNS, [oids])) {
          const tbl = byOid.get(String(c.oid));
          if (!tbl) continue;
          tbl.info.columns.push({
            name: String(c.name),
            type: String(c.type),
            nullable: Boolean(c.nullable),
            ...(c.pk ? { pk: true } : {}),
            ...(c.comment ? { comment: String(c.comment) } : {}),
          });
        }
        for (const f of await catalog(inst, SQL_FKS, [oids])) {
          const tbl = byOid.get(String(f.oid));
          if (!tbl) continue;
          (tbl.info.foreignKeys ??= []).push({
            columns: (f.cols as string[]) ?? [],
            refSchema: String(f.ref_schema),
            refTable: String(f.ref_table),
            refColumns: (f.ref_cols as string[]) ?? [],
          });
        }
      }

      const schemas = schemaNames.map((name) => ({
        name,
        tables: [...byOid.values()].filter((t) => t.schema === name).map((t) => t.info),
      }));
      const snap: SchemaSnapshot = { dialect: DIALECT, defaultSchema, schemas };
      return snap;
    },

    async query(inst, request, params, limits) {
      const started = Date.now();
      const bound = prepareSql(DIALECT, request, params, inst); // guard + bind, always first
      const timeoutMs = Math.min(limits.timeoutMs, cfgNumber(inst.config, "timeoutMs", limits.timeoutMs));
      const maxRows = Math.min(limits.maxRows, cfgNumber(inst.config, "maxRows", limits.maxRows));
      const { names, oids, rows } = await runReadOnly(inst, bound.sql, bound.values ?? [], maxRows, timeoutMs);
      const hints: Record<string, Column["type"]> = {};
      names.forEach((n, i) => {
        const h = typeHint(oids[i]);
        if (h) hints[n] = h;
      });
      return buildResult(names, rows, { ...limits, maxRows }, started, hints);
    },

    async explain(inst, request, params) {
      const bound = prepareSql(DIALECT, request, params, inst);
      const timeoutMs = Math.min(15_000, cfgNumber(inst.config, "timeoutMs", 15_000));
      const { rows } = await runReadOnly(inst, `EXPLAIN ${bound.sql}`, bound.values ?? [], 200, timeoutMs);
      return rows.map((r) => r.join(" ")).join("\n");
    },

    async close(id) {
      await pools.close(id);
    },
  },
});
