import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import {
  defineServerSkill,
  prepareSql,
  buildResult,
  QueryError,
  PoolRegistry,
  cfgString,
  type DatasourceInstance,
  type SchemaSnapshot,
} from "@aibi/skill-sdk";

let dataDir = path.resolve("data");

function resolveFile(cfg: Record<string, unknown>): string {
  const file = cfgString(cfg, "file");
  if (file.includes("..") || path.isAbsolute(file)) throw new QueryError("file must be a name inside data/sqlite", "config");
  const full = path.join(dataDir, "sqlite", file);
  if (!fs.existsSync(full)) throw new QueryError(`database file '${file}' not found in data/sqlite`, "config");
  return full;
}

const pools = new PoolRegistry<DatabaseSync>(
  (cfg) => {
    const db = new DatabaseSync(resolveFile(cfg), { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    return db;
  },
  (db) => db.close(),
);

async function runSelect(inst: DatasourceInstance, sql: string, values: unknown[]) {
  const db = await pools.get(inst);
  const stmt = db.prepare(sql);
  return { stmt, iter: stmt.iterate(...(values as never[])) as IterableIterator<Record<string, unknown>> };
}

export default defineServerSkill({
  init(ctx) {
    dataDir = ctx.dataDir;
    fs.mkdirSync(path.join(dataDir, "sqlite"), { recursive: true });
  },
  datasource: {
    kind: "sql",
    dialect: "sqlite",
    async testConnection(inst) {
      try {
        const db = await pools.get(inst);
        const v = db.prepare("select sqlite_version() as v").get() as { v: string };
        const n = db.prepare("select count(*) as n from sqlite_master where type in ('table','view')").get() as { n: number };
        return { ok: true, message: `SQLite ${v.v}, ${n.n} tables/views`, details: { version: v.v } };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    async introspect(inst) {
      const db = await pools.get(inst);
      const objs = db.prepare("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name").all() as { name: string; type: string }[];
      const tables = objs.map((o) => {
        const cols = db.prepare(`pragma table_info("${o.name.replace(/"/g, '""')}")`).all() as { name: string; type: string; notnull: number; pk: number }[];
        const fks = db.prepare(`pragma foreign_key_list("${o.name.replace(/"/g, '""')}")`).all() as { table: string; from: string; to: string; id: number }[];
        let rowEstimate: number | undefined;
        try {
          rowEstimate = (db.prepare(`select count(*) as n from "${o.name.replace(/"/g, '""')}"`).get() as { n: number }).n;
        } catch {
          rowEstimate = undefined;
        }
        return {
          name: o.name,
          kind: o.type === "view" ? ("view" as const) : ("table" as const),
          rowEstimate,
          columns: cols.map((c) => ({ name: c.name, type: c.type || "any", nullable: !c.notnull, pk: c.pk > 0 })),
          foreignKeys: fks.map((f) => ({ columns: [f.from], refTable: f.table, refColumns: [f.to] })),
        };
      });
      const snap: SchemaSnapshot = { dialect: "sqlite", defaultSchema: "main", schemas: [{ name: "main", tables }] };
      return snap;
    },
    async query(inst, request, params, limits) {
      const started = Date.now();
      const bound = prepareSql("sqlite", request, params, inst);
      let res;
      try {
        res = await runSelect(inst, bound.sql, bound.values);
      } catch (e) {
        throw new QueryError((e as Error).message, "driver");
      }
      const rows: Record<string, unknown>[] = [];
      const deadline = started + limits.timeoutMs;
      for (const r of res.iter) {
        rows.push(r);
        if (rows.length > limits.maxRows) break;
        if ((rows.length & 1023) === 0 && Date.now() > deadline) throw new QueryError("Query exceeded the time limit", "timeout");
      }
      const names = (res.stmt.columns?.() as { name: string }[] | undefined)?.map((c) => c.name) ?? Object.keys(rows[0] ?? {});
      return buildResult(names, rows, limits, started);
    },
    async explain(inst, request, params) {
      const bound = prepareSql("sqlite", request, params, inst);
      const db = await pools.get(inst);
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${bound.sql}`).all(...(bound.values as never[])) as { detail: string }[];
      return plan.map((p) => p.detail).join("\n");
    },
    async close(id) {
      await pools.close(id);
    },
  },
});
