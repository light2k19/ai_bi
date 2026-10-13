/**
 * Integration tests for skills/datasource-postgres against a real PostgreSQL 16 in Docker.
 *
 * Run: npx vitest run --config <config including this file> tools/postgres.connectors.test.ts
 * Starts (or reuses) the container `aibi-postgres` (postgres:16-alpine) on host port 15432.
 */
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryError, type DatasourceInstance, type QueryLimits } from "@aibi/skill-sdk";
import skill from "../skills/datasource-postgres/server/index";

const CONTAINER = "aibi-postgres";
const IMAGE = "postgres:16-alpine";
const PORT = 15432;
const DB = "aibi";
const ADMIN_PW = "Aibi_admin_pw1";
const RO_USER = "aibi_ro";
const RO_PW = "Aibi_ro_pw1";

const ds = skill.datasource!;

const base = { host: "127.0.0.1", port: PORT, database: DB, allowedSchemas: ["sales"], deniedTables: [] as string[] };
const roInst: DatasourceInstance = { id: "pg-ro", alias: "pg", config: { ...base, user: RO_USER, password: RO_PW } };
const adminInst: DatasourceInstance = { id: "pg-admin", alias: "pgadmin", config: { ...base, user: "postgres", password: ADMIN_PW } };
const limits: QueryLimits = { maxRows: 10_000, timeoutMs: 30_000, maxBytes: 50_000_000 };

function sh(cmd: string): string {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

function containerState(): "running" | "stopped" | "missing" {
  try {
    return sh(`docker inspect -f "{{.State.Running}}" ${CONTAINER}`) === "true" ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

function adminClient(): pg.Client {
  return new pg.Client({ host: "127.0.0.1", port: PORT, database: DB, user: "postgres", password: ADMIN_PW });
}

async function adminExec<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  const c = adminClient();
  await c.connect();
  try {
    return (await c.query<T>(sql, values)).rows;
  } finally {
    await c.end();
  }
}

async function waitForPostgres(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let ok = 0;
  let last: unknown;
  // The image restarts the server once after init; require a few consecutive successes.
  while (Date.now() < deadline) {
    try {
      await adminExec("SELECT 1");
      if (++ok >= 3) return;
    } catch (e) {
      ok = 0;
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`PostgreSQL did not become ready: ${(last as Error)?.message}`);
}

async function orderCount(): Promise<number> {
  const [r] = await adminExec<{ n: string }>("SELECT count(*) AS n FROM sales.orders");
  return Number(r.n);
}

beforeAll(async () => {
  const state = containerState();
  if (state === "missing") {
    sh(`docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=${ADMIN_PW} -e POSTGRES_DB=${DB} -p ${PORT}:5432 ${IMAGE}`);
  } else if (state === "stopped") {
    sh(`docker start ${CONTAINER}`);
  }
  await waitForPostgres(300_000);

  const c = adminClient();
  await c.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS sales CASCADE`);
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RO_USER}') THEN
        CREATE ROLE ${RO_USER} LOGIN PASSWORD '${RO_PW}';
      END IF; END $$`);
    await c.query(`ALTER ROLE ${RO_USER} WITH LOGIN PASSWORD '${RO_PW}'`);
    await c.query(`CREATE SCHEMA sales`);
    await c.query(`CREATE TABLE sales.regions (code text PRIMARY KEY, label text NOT NULL)`);
    await c.query(`INSERT INTO sales.regions VALUES ('North','North'),('South','South'),('East','East'),('West','West')`);
    await c.query(`CREATE TABLE sales.orders (
      id integer PRIMARY KEY,
      region text NOT NULL REFERENCES sales.regions(code),
      amount numeric(12,2) NOT NULL,
      sold_at date NOT NULL)`);
    await c.query(`COMMENT ON TABLE sales.orders IS 'One row per order'`);
    await c.query(`COMMENT ON COLUMN sales.orders.amount IS 'Order total in EUR'`);
    await c.query(`INSERT INTO sales.orders (id, region, amount, sold_at)
      SELECT i, (ARRAY['North','South','East','West'])[1 + i % 4], round((i * 7.25)::numeric, 2), DATE '2025-07-01' + (i * 2)
      FROM generate_series(1, 200) AS i`);
    await c.query(`CREATE TABLE sales.secret (id int PRIMARY KEY, v text)`);
    await c.query(`ANALYZE sales.orders`);
    // Read-only role, exactly as section 8 of the spec documents it.
    await c.query(`GRANT CONNECT ON DATABASE ${DB} TO ${RO_USER}`);
    await c.query(`GRANT USAGE ON SCHEMA sales TO ${RO_USER}`);
    await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA sales TO ${RO_USER}`);
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA sales GRANT SELECT ON TABLES TO ${RO_USER}`);
    await c.query(`ALTER ROLE ${RO_USER} SET default_transaction_read_only = on`);
  } finally {
    await c.end();
  }
});

afterAll(async () => {
  await ds.close?.(roInst.id);
  await ds.close?.(adminInst.id);
  await ds.close?.("pg-denied");
});

describe("datasource-postgres", () => {
  it("connection, read-only account: ok and no write privileges", async () => {
    const r = await ds.testConnection(roInst);
    expect(r.ok, r.message).toBe(true);
    expect(r.details?.writePrivileges).toBe(false);
    expect(r.message).toMatch(/^Connected to PostgreSQL 16\.\S+ as aibi_ro, database aibi\. Account is read-only\.$/);
  });

  it("connection, owner/admin account: ok, write privileges and WARNING", async () => {
    const r = await ds.testConnection(adminInst);
    expect(r.ok, r.message).toBe(true);
    expect(r.details?.writePrivileges).toBe(true);
    expect(r.message).toContain("WARNING");
  });

  it("connection failure: ok false and the password is not leaked", async () => {
    const bad: DatasourceInstance = { id: "pg-bad", alias: "bad", config: { ...base, user: RO_USER, password: "wrong-pw-xyz" } };
    const r = await ds.testConnection(bad);
    await ds.close?.(bad.id);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("wrong-pw-xyz");
  });

  it("introspection: finds sales.orders with its columns, primary key, FK and comments", async () => {
    const snap = await ds.introspect(roInst);
    expect(snap.dialect).toBe("postgres");
    expect(snap.defaultSchema).toBe("public");
    const sales = snap.schemas.find((s) => s.name === "sales");
    expect(sales).toBeDefined();
    const orders = sales!.tables.find((t) => t.name === "orders");
    expect(orders).toBeDefined();
    expect(orders!.kind).toBe("table");
    expect(orders!.columns.map((c) => c.name)).toEqual(["id", "region", "amount", "sold_at"]);
    expect(orders!.columns.find((c) => c.name === "id")?.pk).toBe(true);
    expect(orders!.columns.find((c) => c.name === "region")?.pk).toBeFalsy();
    expect(orders!.columns.find((c) => c.name === "amount")?.type).toBe("numeric(12,2)");
    expect(orders!.columns.find((c) => c.name === "amount")?.comment).toBe("Order total in EUR");
    expect(orders!.comment).toBe("One row per order");
    expect(orders!.rowEstimate).toBe(200);
    expect(orders!.foreignKeys).toEqual([{ columns: ["region"], refSchema: "sales", refTable: "regions", refColumns: ["code"] }]);
  });

  it("introspection honours deniedTables", async () => {
    const inst: DatasourceInstance = { id: "pg-denied", alias: "pgd", config: { ...roInst.config, deniedTables: ["sales.secret"] } };
    const snap = await ds.introspect(inst);
    const names = snap.schemas.flatMap((s) => s.tables.map((t) => t.name));
    expect(names).toContain("orders");
    expect(names).not.toContain("secret");
    await expect(ds.query(inst, { sql: "SELECT * FROM sales.secret" }, {}, limits)).rejects.toThrow(/Read-only check failed/);
  });

  it("binding: IN list and date parameter return exactly those regions; numbers are numbers", async () => {
    const params = { regions: ["North", "South"], start: "2026-01-01" };
    const res = await ds.query(
      roInst,
      { sql: "SELECT id, region, amount, sold_at FROM sales.orders WHERE region IN (:regions) AND sold_at >= :start ORDER BY id", params },
      params,
      limits,
    );
    const [{ n }] = await adminExec<{ n: string }>(
      "SELECT count(*) AS n FROM sales.orders WHERE region IN ('North','South') AND sold_at >= DATE '2026-01-01'",
    );
    expect(res.rows.length).toBe(Number(n));
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.truncated).toBe(false);
    expect(res.columns.map((c) => c.name)).toEqual(["id", "region", "amount", "sold_at"]);
    expect(new Set(res.rows.map((r) => r[1]))).toEqual(new Set(["North", "South"]));
    for (const r of res.rows) {
      expect(typeof r[0]).toBe("number");
      expect(typeof r[2]).toBe("number");
      expect(String(r[3]) >= "2026-01-01").toBe(true);
    }
    expect(res.columns.find((c) => c.name === "amount")?.type).toBe("number");
    expect(res.columns.find((c) => c.name === "sold_at")?.type).toBe("date");
    expect(res.rows[0][3]).toMatch(/^\d{4}-\d\d-\d\d$/);
  });

  it("aggregates and casts: count/sum/avg come back as numbers; CAST(:p AS date) works", async () => {
    const params = { start: "2026-01-01" };
    const res = await ds.query(
      roInst,
      {
        sql: "SELECT region, count(*) AS n, sum(amount) AS total, avg(amount)::numeric(12,2) AS avg_amount, date_trunc('month', min(sold_at)) AS first_month FROM sales.orders WHERE sold_at >= CAST(:start AS date) GROUP BY region ORDER BY region",
        params,
      },
      params,
      limits,
    );
    expect(res.rows.length).toBe(4);
    for (const r of res.rows) {
      expect(typeof r[1]).toBe("number");
      expect(typeof r[2]).toBe("number");
      expect(typeof r[3]).toBe("number");
    }
  });

  it("row cap: maxRows 7 on a 200-row table returns 7 rows and truncated", async () => {
    const res = await ds.query(roInst, { sql: "SELECT * FROM sales.orders" }, {}, { ...limits, maxRows: 7 });
    expect(res.rows.length).toBe(7);
    expect(res.truncated).toBe(true);
    // the connection is still usable after stopping early
    const again = await ds.query(roInst, { sql: "SELECT count(*) AS n FROM sales.orders" }, {}, limits);
    expect(again.rows[0][0]).toBe(200);
  });

  it("row cap from the instance config (maxRows) applies too", async () => {
    const inst: DatasourceInstance = { id: "pg-ro", alias: "pg", config: { ...roInst.config, maxRows: 5 } };
    const res = await ds.query(inst, { sql: "SELECT id FROM sales.orders" }, {}, limits);
    expect(res.rows.length).toBe(5);
    expect(res.truncated).toBe(true);
  });

  it("guard: DELETE, UPDATE and multi-statement are rejected even with an admin account", async () => {
    const before = await orderCount();
    for (const sql of ["DELETE FROM sales.orders", "UPDATE sales.orders SET amount = 0", "SELECT 1; DROP TABLE sales.orders"]) {
      const p = ds.query(adminInst, { sql }, {}, limits);
      await expect(p).rejects.toThrow(/Read-only check failed/);
      await expect(p).rejects.toMatchObject({ code: "readonly" });
    }
    expect(await orderCount()).toBe(before);
    expect(before).toBe(200);
  });

  it("driver error: unknown column rejects with a QueryError", async () => {
    const p = ds.query(roInst, { sql: "SELECT no_such_column FROM sales.orders" }, {}, limits);
    await expect(p).rejects.toBeInstanceOf(QueryError);
    await expect(p).rejects.toMatchObject({ code: "driver" });
    await expect(p).rejects.toThrow(/no_such_column/);
  });

  it("timeout: a large cross join with timeoutMs 1000 rejects with code timeout", async () => {
    const started = Date.now();
    const p = ds.query(
      roInst,
      { sql: "SELECT count(*) FROM sales.orders a CROSS JOIN sales.orders b CROSS JOIN sales.orders c CROSS JOIN sales.orders d" },
      {},
      { ...limits, timeoutMs: 1000 },
    );
    await expect(p).rejects.toBeInstanceOf(QueryError);
    await expect(p).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    // pool still healthy afterwards
    const ok = await ds.query(roInst, { sql: "SELECT 1 AS one" }, {}, limits);
    expect(ok.rows).toEqual([[1]]);
  });

  it("explain returns a plan", async () => {
    const params = { regions: ["North"] };
    const plan = await ds.explain!(roInst, { sql: "SELECT * FROM sales.orders WHERE region IN (:regions)", params }, params);
    expect(plan).toMatch(/Scan/);
  });
});
