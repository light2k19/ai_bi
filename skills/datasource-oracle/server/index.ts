import oracledb from "oracledb";
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

oracledb.fetchAsString = [oracledb.CLOB];

function connectString(cfg: Record<string, unknown>) {
  if (cfg.connectString) return String(cfg.connectString);
  return `${cfgString(cfg, "host")}:${cfgNumber(cfg, "port", 1521)}/${cfgString(cfg, "serviceName")}`;
}

const pools = new PoolRegistry<oracledb.Pool>(
  (cfg) =>
    oracledb.createPool({
      user: cfgString(cfg, "user"),
      password: cfg.password ? String(cfg.password) : undefined,
      connectString: connectString(cfg),
      poolMin: 0,
      poolMax: 4,
      poolIncrement: 1,
      poolTimeout: 60,
    }),
  (p) => p.close(0),
);

const lower = (cfg: Record<string, unknown>, n: string) => (cfg.lowercaseColumns !== false && n === n.toUpperCase() ? n.toLowerCase() : n);

async function runReadOnly(inst: DatasourceInstance, sql: string, binds: Record<string, unknown>, maxRows: number, timeoutMs: number): Promise<{ names: string[]; rows: Record<string, unknown>[] }> {
  try {
    return await runReadOnlyOnce(inst, sql, binds, maxRows, timeoutMs);
  } catch (e) {
    // ORA-01466: a read-only transaction cannot read a table altered moments ago; retry once
    if (/ORA-01466/.test((e as Error).message)) {
      await new Promise((r) => setTimeout(r, 2000));
      return runReadOnlyOnce(inst, sql, binds, maxRows, timeoutMs);
    }
    throw e;
  }
}

async function runReadOnlyOnce(inst: DatasourceInstance, sql: string, binds: Record<string, unknown>, maxRows: number, timeoutMs: number) {
  const pool = await pools.get(inst);
  const conn = await pool.getConnection();
  try {
    conn.callTimeout = timeoutMs;
    await conn.execute("SET TRANSACTION READ ONLY");
    const r = await conn.execute<Record<string, unknown>>(sql, binds as oracledb.BindParameters, {
      maxRows: maxRows + 1,
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const names = (r.metaData ?? []).map((m) => m.name);
    return { names, rows: r.rows ?? [] };
  } catch (e) {
    const err = e as Error & { code?: string; errorNum?: number };
    if (err.code === "NJS-123" || err.code === "DPI-1067" || /call timeout/i.test(err.message)) {
      throw new QueryError(`Query exceeded the ${Math.round(timeoutMs / 1000)}s time limit`, "timeout");
    }
    throw new QueryError(err.message, "driver");
  } finally {
    try {
      await conn.rollback();
    } catch {
      /* ignore */
    }
    await conn.close();
  }
}

export default defineServerSkill({
  datasource: {
    kind: "sql",
    dialect: "oracle",
    async testConnection(inst) {
      try {
        const info = await runReadOnly(inst, "SELECT USER AS u, SYS_CONTEXT('USERENV','DB_NAME') AS db, SYS_CONTEXT('USERENV','CON_NAME') AS con FROM dual", {}, 1, 15000);
        const privs = await runReadOnly(inst, "SELECT privilege FROM session_privs", {}, 500, 15000);
        const tabPrivs = await runReadOnly(inst, "SELECT DISTINCT privilege FROM user_tab_privs WHERE privilege IN ('INSERT','UPDATE','DELETE','ALTER')", {}, 50, 15000);
        const owned = await runReadOnly(inst, "SELECT COUNT(*) AS n FROM user_tables", {}, 1, 15000);
        const sysPrivs = privs.rows.map((r) => String(r.PRIVILEGE));
        const risky = sysPrivs.filter((p) => /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|EXECUTE) ANY|^CREATE TABLE|^DBA|^SYSDBA/.test(p));
        const write = risky.length > 0 || tabPrivs.rows.length > 0 || Number(owned.rows[0]?.N ?? 0) > 0;
        const r = info.rows[0];
        return {
          ok: true,
          message: `Connected as ${r.U} to ${r.DB}/${r.CON}` + (write ? ". WARNING: the account can write (system privileges, table grants or owned tables); use a SELECT-only account." : ". Account is read-only."),
          details: { user: r.U, writePrivileges: write, risky },
        };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async introspect(inst) {
      const cfg = inst.config;
      let owners = ((cfg.allowedSchemas as string[] | undefined) ?? []).filter(Boolean).map((s) => s.toUpperCase());
      if (!owners.length) owners = [cfgString(cfg, "user").toUpperCase()];
      const binds: Record<string, string> = {};
      owners.forEach((o, i) => (binds[`o${i}`] = o));
      const inList = owners.map((_, i) => `:o${i}`).join(",");
      const q = (sql: string) => runReadOnly(inst, sql, binds, 200_000, 60_000).then((r) => r.rows);
      const tables = await q(`SELECT owner, table_name, 'table' AS kind, num_rows FROM all_tables WHERE owner IN (${inList})
                              UNION ALL SELECT owner, view_name, 'view', NULL FROM all_views WHERE owner IN (${inList}) ORDER BY 1, 2`);
      const cols = await q(`SELECT owner, table_name, column_name, data_type, nullable FROM all_tab_columns WHERE owner IN (${inList}) ORDER BY owner, table_name, column_id`);
      const pks = await q(`SELECT c.owner, c.table_name, cc.column_name FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
                           WHERE c.constraint_type = 'P' AND c.owner IN (${inList})`);
      const fks = await q(`SELECT c.owner, c.table_name, cc.column_name, r.owner AS r_owner, r.table_name AS r_table, rc.column_name AS r_column
                           FROM all_constraints c
                           JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
                           JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
                           JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position
                           WHERE c.constraint_type = 'R' AND c.owner IN (${inList})`);
      const denied = new Set(((cfg.deniedTables as string[]) ?? []).map((x) => x.toLowerCase()));
      const bySchema = new Map<string, TableInfo[]>();
      for (const t of tables) {
        const s = String(t.OWNER);
        const n = String(t.TABLE_NAME);
        if (denied.has(n.toLowerCase()) || denied.has(`${s}.${n}`.toLowerCase())) continue;
        const pkCols = new Set(pks.filter((p) => p.OWNER === s && p.TABLE_NAME === n).map((p) => String(p.COLUMN_NAME)));
        const info: TableInfo = {
          name: n,
          kind: t.KIND === "view" ? "view" : "table",
          rowEstimate: t.NUM_ROWS === null || t.NUM_ROWS === undefined ? undefined : Number(t.NUM_ROWS),
          columns: cols.filter((c) => c.OWNER === s && c.TABLE_NAME === n).map((c) => ({ name: String(c.COLUMN_NAME), type: String(c.DATA_TYPE), nullable: c.NULLABLE === "Y", pk: pkCols.has(String(c.COLUMN_NAME)) })),
          foreignKeys: fks.filter((f) => f.OWNER === s && f.TABLE_NAME === n).map((f) => ({ columns: [String(f.COLUMN_NAME)], refSchema: String(f.R_OWNER), refTable: String(f.R_TABLE), refColumns: [String(f.R_COLUMN)] })),
        };
        if (!bySchema.has(s)) bySchema.set(s, []);
        bySchema.get(s)!.push(info);
      }
      const snap: SchemaSnapshot = { dialect: "oracle", defaultSchema: owners[0], schemas: [...bySchema].map(([name, t]) => ({ name, tables: t })) };
      return snap;
    },
    async query(inst, request, params, limits) {
      const started = Date.now();
      const bound = prepareSql("oracle", request, params, inst);
      const timeoutMs = Math.min(limits.timeoutMs, cfgNumber(inst.config, "timeoutMs", limits.timeoutMs));
      const maxRows = Math.min(limits.maxRows, cfgNumber(inst.config, "maxRows", limits.maxRows));
      const { names, rows } = await runReadOnly(inst, bound.sql, bound.named, maxRows, timeoutMs);
      const outNames = names.map((n) => lower(inst.config, n));
      const renamed = rows.map((r) => Object.fromEntries(names.map((n, i) => [outNames[i], r[n]])));
      return buildResult(outNames, renamed, { ...limits, maxRows }, started);
    },
    async explain(inst, request, params) {
      // EXPLAIN PLAN writes to PLAN_TABLE, so it cannot run in a READ ONLY transaction; it is rolled back.
      const bound = prepareSql("oracle", request, params, inst);
      const pool = await pools.get(inst);
      const conn = await pool.getConnection();
      try {
        conn.callTimeout = 15000;
        await conn.execute(`EXPLAIN PLAN SET STATEMENT_ID = 'aibi' FOR ${bound.sql}`);
        const r = await conn.execute<{ PLAN_TABLE_OUTPUT: string }>(`SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, 'aibi', 'BASIC ROWS'))`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        return (r.rows ?? []).map((x) => x.PLAN_TABLE_OUTPUT).join("\n");
      } finally {
        try {
          await conn.rollback();
        } catch {
          /* ignore */
        }
        await conn.close();
      }
    },
    async close(id) {
      await pools.close(id);
    },
  },
});
