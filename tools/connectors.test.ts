/**
 * Connector integration tests against real engines in Docker (MySQL 8.4, SQL Server 2022, Oracle Free 23).
 * Run: npm run test:connectors   (needs Docker; containers are reused between runs)
 * Select engines with AIBI_ENGINES=mysql,mssql,oracle
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import type { DatasourceHandler, DatasourceInstance } from "@aibi/skill-sdk";

const ENGINES = (process.env.AIBI_ENGINES ?? "mysql,mssql,oracle").split(",");
const LIMITS = { maxRows: 1000, timeoutMs: 20_000, maxBytes: 5_000_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sh(cmd: string) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}
function ensureContainer(name: string, run: string) {
  const state = (() => {
    try {
      return sh(`docker inspect -f "{{.State.Running}}" ${name}`);
    } catch {
      return "missing";
    }
  })();
  if (state === "missing") sh(run);
  else if (state === "false") sh(`docker start ${name}`);
}
async function until<T>(what: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(3000);
    }
  }
  throw new Error(`${what} not ready: ${(last as Error)?.message}`);
}

const REGIONS = ["North", "South", "East", "West", "Central"];

/** Shared assertions for every SQL engine. */
function sqlSuite(engine: string, ctx: () => { h: DatasourceHandler; ro: DatasourceInstance; admin: DatasourceInstance; table: string; dateExpr: (p: string) => string }) {
  it(`${engine}: test connection reports read-only vs write privileges`, async () => {
    const { h, ro, admin } = ctx();
    const a = await h.testConnection(ro);
    expect(a.ok, a.message).toBe(true);
    expect(a.details?.writePrivileges, a.message).toBe(false);
    const b = await h.testConnection(admin);
    expect(b.ok, b.message).toBe(true);
    expect(b.details?.writePrivileges, b.message).toBe(true);
  });

  it(`${engine}: introspection finds the table and columns`, async () => {
    const { h, ro, table } = ctx();
    const snap = await h.introspect(ro);
    const t = snap.schemas.flatMap((s) => s.tables).find((x) => x.name.toLowerCase() === table.split(".").pop()!.toLowerCase());
    expect(t, JSON.stringify(snap.schemas.map((s) => s.name))).toBeTruthy();
    expect(t!.columns.map((c) => c.name.toLowerCase())).toEqual(expect.arrayContaining(["id", "region", "amount", "sold_at"]));
  });

  it(`${engine}: parameter binding with IN lists and dates`, async () => {
    const { h, ro, table, dateExpr } = ctx();
    const sql = `SELECT region, SUM(amount) AS revenue, COUNT(*) AS n FROM ${table} WHERE region IN (:regions) AND sold_at >= ${dateExpr(":start")} GROUP BY region ORDER BY region`;
    const r = await h.query(ro, { sql }, { regions: ["North", "South"], start: "2026-01-01" }, LIMITS);
    expect(r.rows.map((x) => x[0])).toEqual(["North", "South"]);
    expect(r.columns.map((c) => c.name.toLowerCase())).toEqual(["region", "revenue", "n"]);
    expect(typeof r.rows[0][1]).toBe("number");
  });

  it(`${engine}: row cap truncates`, async () => {
    const { h, ro, table } = ctx();
    const r = await h.query(ro, { sql: `SELECT id, region FROM ${table} ORDER BY id` }, {}, { ...LIMITS, maxRows: 7 });
    expect(r.rows.length).toBe(7);
    expect(r.truncated).toBe(true);
  });

  it(`${engine}: writes are rejected before reaching the database`, async () => {
    const { h, admin, table } = ctx();
    for (const sql of [`DELETE FROM ${table}`, `UPDATE ${table} SET amount = 0`, `SELECT 1 FROM ${table}; DROP TABLE ${table}`]) {
      await expect(h.query(admin, { sql }, {}, LIMITS)).rejects.toThrow(/Read-only check failed/);
    }
    const r = await h.query(admin, { sql: `SELECT COUNT(*) AS n FROM ${table}` }, {}, LIMITS);
    expect(Number(r.rows[0][0])).toBe(200);
  });

  it(`${engine}: driver errors surface clearly`, async () => {
    const { h, ro, table } = ctx();
    await expect(h.query(ro, { sql: `SELECT no_such_column FROM ${table}` }, {}, LIMITS)).rejects.toThrow();
  });
}

/* ───────── MySQL ───────── */
describe.runIf(ENGINES.includes("mysql"))("mysql", () => {
  let h: DatasourceHandler;
  const base = { host: "127.0.0.1", port: 13306, database: "sales" };
  const ro: DatasourceInstance = { id: "my-ro", alias: "my", config: { ...base, user: "ro", password: "Ro_pass12" } };
  const admin: DatasourceInstance = { id: "my-admin", alias: "my", config: { ...base, user: "root", password: "Root_pass1" } };
  beforeAll(async () => {
    ensureContainer("aibi-mysql", "docker run -d --name aibi-mysql -e MYSQL_ROOT_PASSWORD=Root_pass1 -e MYSQL_DATABASE=sales -p 13306:3306 mysql:8.4");
    const mysql = (await import("mysql2/promise")).default;
    const conn = await until("mysql", () => mysql.createConnection({ host: "127.0.0.1", port: 13306, user: "root", password: "Root_pass1", database: "sales", multipleStatements: true }), 180_000);
    await conn.query(`
      DROP TABLE IF EXISTS orders;
      CREATE TABLE orders (id INT PRIMARY KEY, region VARCHAR(20), amount DECIMAL(12,2), sold_at DATE) COMMENT 'Orders';
      CREATE USER IF NOT EXISTS 'ro'@'%' IDENTIFIED BY 'Ro_pass12';
      GRANT SELECT ON sales.* TO 'ro'@'%';`);
    const rows = Array.from({ length: 200 }, (_, i) => [i + 1, REGIONS[i % 5], 100 + i, `2026-0${(i % 9) + 1}-15`]);
    await conn.query("INSERT INTO orders VALUES ?", [rows]);
    await conn.end();
    h = (await import("../skills/datasource-mysql/server/index")).default.datasource!;
  }, 240_000);
  sqlSuite("mysql", () => ({ h, ro, admin, table: "orders", dateExpr: (p) => p }));
});

/* ───────── SQL Server ───────── */
describe.runIf(ENGINES.includes("mssql"))("mssql", () => {
  let h: DatasourceHandler;
  const base = { server: "127.0.0.1", port: 11433, database: "sales", encrypt: true, trustServerCertificate: true };
  const ro: DatasourceInstance = { id: "ms-ro", alias: "ms", config: { ...base, user: "ro", password: "Ro_pass12!" } };
  const admin: DatasourceInstance = { id: "ms-admin", alias: "ms", config: { ...base, user: "sa", password: "Root_pass1!" } };
  beforeAll(async () => {
    ensureContainer("aibi-mssql", 'docker run -d --name aibi-mssql -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=Root_pass1!" -p 11433:1433 mcr.microsoft.com/mssql/server:2022-latest');
    const mssql = (await import("mssql")).default;
    const master = await until("mssql", () => new mssql.ConnectionPool({ server: "127.0.0.1", port: 11433, user: "sa", password: "Root_pass1!", database: "master", options: { encrypt: true, trustServerCertificate: true } }).connect(), 240_000);
    await master.request().batch("IF DB_ID('sales') IS NULL CREATE DATABASE sales; IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = 'ro') CREATE LOGIN ro WITH PASSWORD = 'Ro_pass12!', CHECK_POLICY = OFF;");
    await master.close();
    const db = await new mssql.ConnectionPool({ server: "127.0.0.1", port: 11433, user: "sa", password: "Root_pass1!", database: "sales", options: { encrypt: true, trustServerCertificate: true } }).connect();
    await db.request().batch(`
      IF OBJECT_ID('dbo.orders') IS NOT NULL DROP TABLE dbo.orders;
      CREATE TABLE dbo.orders (id INT PRIMARY KEY, region NVARCHAR(20), amount DECIMAL(12,2), sold_at DATE);
      IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'ro') CREATE USER ro FOR LOGIN ro;
      ALTER ROLE db_datareader ADD MEMBER ro;`);
    const values = Array.from({ length: 200 }, (_, i) => `(${i + 1}, N'${REGIONS[i % 5]}', ${100 + i}, '2026-0${(i % 9) + 1}-15')`).join(",");
    await db.request().batch(`INSERT INTO dbo.orders VALUES ${values}`);
    await db.close();
    h = (await import("../skills/datasource-mssql/server/index")).default.datasource!;
  }, 300_000);
  sqlSuite("mssql", () => ({ h, ro, admin, table: "dbo.orders", dateExpr: (p) => p }));
});

/* ───────── Oracle ───────── */
describe.runIf(ENGINES.includes("oracle"))("oracle", () => {
  let h: DatasourceHandler;
  const base = { host: "127.0.0.1", port: 11521, serviceName: "FREEPDB1", allowedSchemas: ["SALES"] };
  const ro: DatasourceInstance = { id: "or-ro", alias: "or", config: { ...base, user: "ro", password: "Ro_pass12" } };
  const admin: DatasourceInstance = { id: "or-admin", alias: "or", config: { ...base, user: "sales", password: "Sales_pass1" } };
  beforeAll(async () => {
    ensureContainer("aibi-oracle", "docker run -d --name aibi-oracle -e ORACLE_PASSWORD=Root_pass1 -e APP_USER=sales -e APP_USER_PASSWORD=Sales_pass1 -p 11521:1521 gvenzl/oracle-free:23-slim");
    const oracledb = (await import("oracledb")).default;
    const sys = await until("oracle", () => oracledb.getConnection({ user: "system", password: "Root_pass1", connectString: "127.0.0.1:11521/FREEPDB1" }), 600_000);
    const own = await oracledb.getConnection({ user: "sales", password: "Sales_pass1", connectString: "127.0.0.1:11521/FREEPDB1" });
    try {
      await own.execute("DROP TABLE orders PURGE");
    } catch {
      /* first run */
    }
    await own.execute("CREATE TABLE orders (id NUMBER PRIMARY KEY, region VARCHAR2(20), amount NUMBER(12,2), sold_at DATE)");
    const rows = Array.from({ length: 200 }, (_, i) => [i + 1, REGIONS[i % 5], 100 + i, new Date(Date.UTC(2026, i % 9, 15))]);
    await own.executeMany("INSERT INTO orders VALUES (:1, :2, :3, :4)", rows);
    await own.commit();
    try {
      await sys.execute("CREATE USER ro IDENTIFIED BY Ro_pass12");
    } catch {
      /* exists */
    }
    await sys.execute("GRANT CREATE SESSION TO ro");
    await sys.execute("GRANT SELECT ON sales.orders TO ro");
    await own.close();
    await sys.close();
    // read-only transactions cannot see tables whose DDL is only seconds old (ORA-01466)
    await sleep(5000);
    h = (await import("../skills/datasource-oracle/server/index")).default.datasource!;
  }, 700_000);
  sqlSuite("oracle", () => ({ h, ro, admin, table: "sales.orders", dateExpr: (p) => `TO_DATE(${p}, 'YYYY-MM-DD')` }));
});
