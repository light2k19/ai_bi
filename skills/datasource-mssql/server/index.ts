import mssql from "mssql";
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

const pools = new PoolRegistry<mssql.ConnectionPool>(
  async (cfg) => {
    const pool = new mssql.ConnectionPool({
      server: cfgString(cfg, "server"),
      port: cfg.instanceName ? undefined : cfgNumber(cfg, "port", 1433),
      database: cfgString(cfg, "database"),
      user: cfgString(cfg, "user"),
      password: cfg.password ? String(cfg.password) : undefined,
      connectionTimeout: 15_000,
      requestTimeout: cfgNumber(cfg, "timeoutMs", 30_000),
      pool: { max: 4, min: 0, idleTimeoutMillis: 60_000 },
      options: {
        encrypt: cfg.encrypt !== false,
        trustServerCertificate: cfg.trustServerCertificate === true,
        instanceName: cfg.instanceName ? String(cfg.instanceName) : undefined,
        readOnlyIntent: true,
        enableArithAbort: true,
      },
    });
    await pool.connect();
    return pool;
  },
  (p) => p.close(),
);

/**
 * Execute inside a transaction that is always rolled back: even if a write slipped past the
 * guard and the grants, nothing would persist. Streams at most maxRows+1 rows.
 */
async function runReadOnly(inst: DatasourceInstance, sqlText: string, named: Record<string, unknown>, maxRows: number, timeoutMs: number) {
  const pool = await pools.get(inst);
  const tx = new mssql.Transaction(pool);
  await tx.begin(mssql.ISOLATION_LEVEL.READ_COMMITTED);
  try {
    const result = await new Promise<{ names: string[]; rows: Record<string, unknown>[] }>((resolve, reject) => {
      const req = new mssql.Request(tx);
      (req as unknown as { stream: boolean }).stream = true;
      for (const [k, v] of Object.entries(named)) req.input(k, v as never);
      const rows: Record<string, unknown>[] = [];
      let names: string[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.cancel();
        reject(new QueryError(`Query exceeded the ${Math.round(timeoutMs / 1000)}s time limit`, "timeout"));
      }, timeoutMs);
      req.on("recordset", (cols: Record<string, unknown>) => {
        if (!names.length) names = Object.keys(cols);
      });
      req.on("row", (row: Record<string, unknown>) => {
        if (settled) return;
        rows.push(row);
        if (rows.length > maxRows) {
          settled = true;
          clearTimeout(timer);
          req.cancel();
          resolve({ names, rows });
        }
      });
      req.on("error", (err: Error & { code?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new QueryError(err.message, "driver"));
      });
      req.on("done", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ names, rows });
      });
      req.query(sqlText);
    });
    return result;
  } finally {
    try {
      await tx.rollback();
    } catch {
      /* a cancelled request may already have aborted the transaction */
    }
  }
}

export default defineServerSkill({
  datasource: {
    kind: "sql",
    dialect: "mssql",
    async testConnection(inst) {
      try {
        const { rows } = await runReadOnly(
          inst,
          `SELECT @@VERSION AS v, SUSER_SNAME() AS u, DB_NAME() AS db,
                  IS_ROLEMEMBER('db_owner') AS isOwner, IS_ROLEMEMBER('db_datawriter') AS isWriter, IS_ROLEMEMBER('db_ddladmin') AS isDdl,
                  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') AS canInsert, HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE') AS canUpdate`,
          {},
          5,
          15_000,
        );
        const r = rows[0];
        const write = [r.isOwner, r.isWriter, r.isDdl, r.canInsert, r.canUpdate].some((x) => Number(x) === 1);
        return {
          ok: true,
          message: `Connected to ${String(r.v).split("\n")[0]} as ${r.u}, database ${r.db}` + (write ? ". WARNING: the account can write; use a db_datareader-only login." : ". Account is read-only."),
          details: { user: r.u, writePrivileges: write },
        };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async introspect(inst) {
      const cfg = inst.config;
      const allowed = ((cfg.allowedSchemas as string[] | undefined) ?? []).filter(Boolean).map((s) => s.toLowerCase());
      const q = (s: string) => runReadOnly(inst, s, {}, 100_000, 60_000).then((r) => r.rows);
      const tables = await q(`SELECT t.TABLE_SCHEMA s, t.TABLE_NAME n, t.TABLE_TYPE tt,
          (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = OBJECT_ID(QUOTENAME(t.TABLE_SCHEMA) + '.' + QUOTENAME(t.TABLE_NAME)) AND p.index_id IN (0,1)) AS rc
        FROM INFORMATION_SCHEMA.TABLES t WHERE t.TABLE_SCHEMA NOT IN ('sys','INFORMATION_SCHEMA') ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME`);
      const cols = await q(`SELECT c.TABLE_SCHEMA s, c.TABLE_NAME n, c.COLUMN_NAME c, c.DATA_TYPE ty, c.IS_NULLABLE nl,
          CASE WHEN k.COLUMN_NAME IS NULL THEN 0 ELSE 1 END pk
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                   JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
                   WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY') k
          ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.TABLE_SCHEMA NOT IN ('sys','INFORMATION_SCHEMA')
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`);
      let fks: Record<string, unknown>[] = [];
      try {
        fks = await q(`SELECT SCHEMA_NAME(pt.schema_id) s, pt.name n, pc.name c, SCHEMA_NAME(rt.schema_id) rs, rt.name rt, rc.name rc
          FROM sys.foreign_key_columns fkc
          JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
          JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
          JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
          JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id`);
      } catch {
        fks = [];
      }
      const denied = new Set(((cfg.deniedTables as string[]) ?? []).map((x) => x.toLowerCase()));
      const bySchema = new Map<string, TableInfo[]>();
      for (const t of tables) {
        const s = String(t.s);
        const n = String(t.n);
        if (allowed.length && !allowed.includes(s.toLowerCase())) continue;
        if (denied.has(n.toLowerCase()) || denied.has(`${s}.${n}`.toLowerCase())) continue;
        const info: TableInfo = {
          name: n,
          kind: String(t.tt).includes("VIEW") ? "view" : "table",
          rowEstimate: t.rc === null || t.rc === undefined ? undefined : Number(t.rc),
          columns: cols.filter((c) => c.s === s && c.n === n).map((c) => ({ name: String(c.c), type: String(c.ty), nullable: c.nl === "YES", pk: Number(c.pk) === 1 })),
          foreignKeys: fks.filter((f) => f.s === s && f.n === n).map((f) => ({ columns: [String(f.c)], refSchema: String(f.rs), refTable: String(f.rt), refColumns: [String(f.rc)] })),
        };
        if (!bySchema.has(s)) bySchema.set(s, []);
        bySchema.get(s)!.push(info);
      }
      const snap: SchemaSnapshot = { dialect: "mssql", defaultSchema: "dbo", schemas: [...bySchema].map(([name, t]) => ({ name, tables: t })) };
      return snap;
    },
    async query(inst, request, params, limits) {
      const started = Date.now();
      const bound = prepareSql("mssql", request, params, inst);
      const timeoutMs = Math.min(limits.timeoutMs, cfgNumber(inst.config, "timeoutMs", limits.timeoutMs));
      const maxRows = Math.min(limits.maxRows, cfgNumber(inst.config, "maxRows", limits.maxRows));
      const { names, rows } = await runReadOnly(inst, bound.sql, bound.named, maxRows, timeoutMs);
      return buildResult(names, rows, { ...limits, maxRows }, started);
    },
    async explain(inst, request, params) {
      const bound = prepareSql("mssql", request, params, inst);
      const pool = await pools.get(inst);
      const tx = new mssql.Transaction(pool);
      await tx.begin();
      try {
        await new mssql.Request(tx).batch("SET SHOWPLAN_TEXT ON");
        const req = new mssql.Request(tx);
        for (const [k, v] of Object.entries(bound.named)) req.input(k, v as never);
        const r = await req.query(bound.sql);
        await new mssql.Request(tx).batch("SET SHOWPLAN_TEXT OFF");
        return (r.recordsets as unknown as Record<string, unknown>[][]).flat().map((x) => String(Object.values(x)[0])).join("\n");
      } finally {
        try {
          await tx.rollback();
        } catch {
          /* ignore */
        }
      }
    },
    async close(id) {
      await pools.close(id);
    },
  },
});
