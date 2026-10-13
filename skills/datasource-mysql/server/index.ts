import mysql from "mysql2";
import type { Pool, PoolConnection, FieldPacket } from "mysql2";
import {
  defineServerSkill,
  prepareSql,
  buildResult,
  QueryError,
  PoolRegistry,
  cfgString,
  cfgNumber,
  type DatasourceInstance,
  type SchemaSnapshot,
  type TableInfo,
} from "@aibi/skill-sdk";

const pools = new PoolRegistry<Pool>(
  (cfg) =>
    mysql.createPool({
      host: cfgString(cfg, "host"),
      port: cfgNumber(cfg, "port", 3306),
      user: cfgString(cfg, "user"),
      password: cfg.password ? String(cfg.password) : undefined,
      database: cfgString(cfg, "database"),
      ssl: cfg.ssl ? { rejectUnauthorized: cfg.sslRejectUnauthorized !== false } : undefined,
      connectionLimit: 4,
      maxIdle: 2,
      idleTimeout: 60_000,
      connectTimeout: 10_000,
      dateStrings: true,
      decimalNumbers: true,
      supportBigNumbers: true,
      multipleStatements: false,
      namedPlaceholders: false,
    }),
  (p) => new Promise<void>((resolve) => p.end(() => resolve())),
);

function getConn(pool: Pool): Promise<PoolConnection> {
  return new Promise((resolve, reject) => pool.getConnection((err, c) => (err ? reject(new QueryError(err.message, "driver")) : resolve(c))));
}
function exec(conn: PoolConnection, sql: string, values: unknown[] = [], timeout?: number): Promise<{ rows: Record<string, unknown>[]; fields?: FieldPacket[] }> {
  return new Promise((resolve, reject) =>
    conn.query({ sql, values, timeout }, (err, rows, fields) => (err ? reject(err) : resolve({ rows: rows as Record<string, unknown>[], fields: fields as FieldPacket[] }))),
  );
}

/** Run a statement inside a read-only transaction and stream at most maxRows+1 rows. */
async function streamReadOnly(inst: DatasourceInstance, sql: string, values: unknown[], maxRows: number, timeoutMs: number) {
  const pool = await pools.get(inst);
  const conn = await getConn(pool);
  let destroyed = false;
  try {
    await exec(conn, "SET SESSION TRANSACTION READ ONLY");
    await exec(conn, "START TRANSACTION READ ONLY");
    const out = await new Promise<{ names: string[]; rows: Record<string, unknown>[] }>((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      let names: string[] = [];
      let done = false;
      const q = conn.query({ sql, values, timeout: timeoutMs });
      q.on("fields", (f: FieldPacket[]) => (names = f.map((x) => x.name)));
      q.on("result", (row: unknown) => {
        if (done) return;
        rows.push(row as Record<string, unknown>);
        if (rows.length > maxRows) {
          done = true;
          // stop reading: the connection has unread results, so it must be destroyed
          conn.destroy();
          destroyed = true;
          resolve({ names, rows });
        }
      });
      q.on("error", (err: Error & { code?: string }) => {
        if (done) return;
        done = true;
        reject(err.code === "PROTOCOL_SEQUENCE_TIMEOUT" ? new QueryError(`Query exceeded the ${Math.round(timeoutMs / 1000)}s time limit`, "timeout") : new QueryError(err.message, "driver"));
      });
      q.on("end", () => {
        if (!done) {
          done = true;
          resolve({ names, rows });
        }
      });
    });
    return out;
  } catch (e) {
    if (!destroyed) {
      conn.destroy();
      destroyed = true;
    }
    throw e instanceof QueryError ? e : new QueryError((e as Error).message, "driver");
  } finally {
    if (!destroyed) {
      try {
        await exec(conn, "ROLLBACK");
      } catch {
        /* ignore */
      }
      conn.release();
    }
  }
}

async function withConn<T>(inst: DatasourceInstance, fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getConn(await pools.get(inst));
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

const WRITE_PRIVS = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|GRANT OPTION|SUPER|FILE|EXECUTE|EVENT|TRIGGER|CREATE ROUTINE|ALTER ROUTINE)\b/;

export default defineServerSkill({
  datasource: {
    kind: "sql",
    dialect: "mysql",
    async testConnection(inst) {
      try {
        return await withConn(inst, async (c) => {
          const v = (await exec(c, "SELECT VERSION() AS v, CURRENT_USER() AS u, DATABASE() AS db")).rows[0];
          const grants = (await exec(c, "SHOW GRANTS")).rows.map((r) => String(Object.values(r)[0]));
          const risky = grants.filter((g) => WRITE_PRIVS.test(g.split(" ON ")[0]));
          return {
            ok: true,
            message: `Connected to ${v.v} as ${v.u}, database ${v.db}` + (risky.length ? `. WARNING: the account has write privileges; use a SELECT-only account.` : ". Account is read-only."),
            details: { version: v.v, user: v.u, grants, writePrivileges: risky.length > 0 },
          };
        });
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async introspect(inst) {
      const cfg = inst.config;
      const schemas = ((cfg.allowedSchemas as string[] | undefined)?.filter(Boolean).length ? (cfg.allowedSchemas as string[]) : [cfgString(cfg, "database")]).map(String);
      return withConn(inst, async (c) => {
        const ph = schemas.map(() => "?").join(",");
        const tables = (await exec(c, `SELECT TABLE_SCHEMA s, TABLE_NAME t, TABLE_TYPE tt, TABLE_ROWS n, TABLE_COMMENT cm FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (${ph}) ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT 1000`, schemas)).rows;
        const cols = (await exec(c, `SELECT TABLE_SCHEMA s, TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty, IS_NULLABLE nl, COLUMN_KEY k, COLUMN_COMMENT cm FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (${ph}) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`, schemas)).rows;
        const fks = (await exec(c, `SELECT TABLE_SCHEMA s, TABLE_NAME t, COLUMN_NAME c, REFERENCED_TABLE_SCHEMA rs, REFERENCED_TABLE_NAME rt, REFERENCED_COLUMN_NAME rc FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA IN (${ph}) AND REFERENCED_TABLE_NAME IS NOT NULL`, schemas)).rows;
        const denied = new Set(((cfg.deniedTables as string[]) ?? []).map((x) => x.toLowerCase()));
        const bySchema = new Map<string, TableInfo[]>();
        for (const t of tables) {
          const s = String(t.s);
          const name = String(t.t);
          if (denied.has(name.toLowerCase()) || denied.has(`${s}.${name}`.toLowerCase())) continue;
          const info: TableInfo = {
            name,
            kind: String(t.tt).includes("VIEW") ? "view" : "table",
            rowEstimate: t.n === null ? undefined : Number(t.n),
            comment: t.cm ? String(t.cm) : undefined,
            columns: cols.filter((x) => x.s === s && x.t === name).map((x) => ({ name: String(x.c), type: String(x.ty), nullable: x.nl === "YES", pk: x.k === "PRI", comment: x.cm ? String(x.cm) : undefined })),
            foreignKeys: fks.filter((x) => x.s === s && x.t === name).map((x) => ({ columns: [String(x.c)], refSchema: String(x.rs), refTable: String(x.rt), refColumns: [String(x.rc)] })),
          };
          if (!bySchema.has(s)) bySchema.set(s, []);
          bySchema.get(s)!.push(info);
        }
        const snap: SchemaSnapshot = { dialect: "mysql", defaultSchema: cfgString(cfg, "database"), schemas: [...bySchema].map(([name, t]) => ({ name, tables: t })) };
        return snap;
      });
    },
    async query(inst, request, params, limits) {
      const started = Date.now();
      const bound = prepareSql("mysql", request, params, inst);
      const timeoutMs = Math.min(limits.timeoutMs, cfgNumber(inst.config, "timeoutMs", limits.timeoutMs));
      const maxRows = Math.min(limits.maxRows, cfgNumber(inst.config, "maxRows", limits.maxRows));
      const { names, rows } = await streamReadOnly(inst, bound.sql, bound.values, maxRows, timeoutMs);
      return buildResult(names, rows, { ...limits, maxRows }, started);
    },
    async explain(inst, request, params) {
      const bound = prepareSql("mysql", request, params, inst);
      const { rows } = await streamReadOnly(inst, `EXPLAIN ${bound.sql}`, bound.values, 200, 15000);
      return rows.map((r) => `${r.table ?? ""} type=${r.type ?? ""} key=${r.key ?? "-"} rows=${r.rows ?? "?"} ${r.Extra ?? ""}`).join("\n");
    },
    async close(id) {
      await pools.close(id);
    },
  },
});
