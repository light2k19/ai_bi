import { describe, expect, it } from "vitest";
import { checkReadOnly, bindParams, type Dialect } from "./index";

const ok = (sql: string, d: Dialect = "mysql") => {
  const r = checkReadOnly(sql, d);
  if (!r.ok) throw new Error(`expected ok: ${sql}\n${r.errors.join("\n")}`);
  return r;
};
const bad = (sql: string, d: Dialect = "mysql") => {
  const r = checkReadOnly(sql, d);
  expect(r.ok, `expected rejection: ${sql}`).toBe(false);
  return r;
};

describe("checkReadOnly accepts analytical queries", () => {
  it("simple select with params", () => {
    const r = ok("SELECT region, SUM(amount) AS revenue FROM sales.orders WHERE sold_at >= :from AND sold_at < :to GROUP BY region ORDER BY revenue DESC");
    expect(r.params).toEqual(["from", "to"]);
  });
  it("CTE, window functions, joins with aliases", () => {
    ok(`WITH m AS (SELECT r.name AS region, DATE_FORMAT(o.sold_at,'%Y-%m') AS ym, SUM(o.amount) amt
          FROM orders o JOIN regions r ON r.id = o.region_id GROUP BY 1,2)
        SELECT region, ym, amt, LAG(amt) OVER (PARTITION BY region ORDER BY ym) AS prev FROM m;`);
  });
  it("string literals containing banned words are fine", () => {
    ok("SELECT 'DELETE FROM x; DROP TABLE y' AS note, REPLACE(name,'a','b') FROM customers");
  });
  it("comments containing banned words are fine", () => {
    ok("SELECT 1 -- update everything\n FROM dual /* insert */", "oracle");
  });
  it("mssql bracket identifiers and TOP", () => {
    ok("SELECT TOP 10 [Order Id], c.[Name] FROM dbo.Orders o JOIN dbo.Customers c ON c.Id = o.CustomerId", "mssql");
  });
  it("oracle FETCH FIRST and q-quotes", () => {
    ok("SELECT q'[it's]' AS s, x FROM sales.t FETCH FIRST 10 ROWS ONLY", "oracle");
  });
  it("parenthesised union", () => {
    ok("(SELECT a FROM t1) UNION ALL (SELECT a FROM t2)", "postgres");
  });
  it("qualified column named set via alias", () => {
    ok("SELECT t.set FROM things t", "postgres");
  });
});

describe("checkReadOnly rejects writes and abuse", () => {
  it.each([
    ["DELETE FROM orders"],
    ["UPDATE orders SET amount = 0"],
    ["INSERT INTO t VALUES (1)"],
    ["DROP TABLE orders"],
    ["SELECT 1; DROP TABLE orders"],
    ["SELECT * INTO OUTFILE '/tmp/x' FROM orders"],
    ["SELECT * FROM orders FOR UPDATE"],
    ["WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"],
    ["SELECT SLEEP(100)"],
    ["SELECT @a := 1"],
    ["/*!50000 DROP TABLE t */ SELECT 1"],
    ["SELECT * FROM mysql.user"],
    ["CALL do_stuff()"],
    ["  "],
  ])("mysql: %s", (sql) => {
    bad(sql, "mysql");
  });
  it.each([
    ["EXEC xp_cmdshell 'dir'"],
    ["SELECT * INTO #tmp FROM orders"],
    ["SELECT * FROM OPENROWSET('SQLNCLI','x','select 1')"],
    ["SELECT 1; WAITFOR DELAY '00:00:10'"],
    ["SELECT * FROM sys.sql_logins"],
    ["SELECT name FROM master.dbo.sysdatabases"],
  ])("mssql: %s", (sql) => {
    bad(sql, "mssql");
  });
  it.each([
    ["SELECT DBMS_PIPE.RECEIVE_MESSAGE('a',10) FROM dual"],
    ["SELECT UTL_HTTP.REQUEST('http://x') FROM dual"],
    ["SELECT * FROM sys.user$"],
    ["BEGIN NULL; END;"],
  ])("oracle: %s", (sql) => {
    bad(sql, "oracle");
  });
  it("unterminated string", () => {
    bad("SELECT 'abc FROM t");
  });
  it("denied tables and allowed schemas", () => {
    expect(checkReadOnly("SELECT * FROM hr.salaries", "mysql", { deniedTables: ["hr.salaries"] }).ok).toBe(false);
    expect(checkReadOnly("SELECT * FROM salaries s", "mysql", { deniedTables: ["salaries"] }).ok).toBe(false);
    expect(checkReadOnly("SELECT * FROM hr.people", "mysql", { allowedSchemas: ["sales"] }).ok).toBe(false);
    expect(checkReadOnly("SELECT o.id FROM sales.orders o", "mysql", { allowedSchemas: ["sales"] }).ok).toBe(true);
    expect(checkReadOnly("SELECT orders.amount FROM sales.orders", "mysql", { allowedSchemas: ["sales"] }).ok).toBe(true);
  });
});

describe("bindParams", () => {
  it("mysql positional with array expansion", () => {
    const b = bindParams("SELECT * FROM t WHERE a = :a AND r IN (:regions) AND s = ':not_param'", { a: 1, regions: ["N", "S"] }, "mysql");
    expect(b.sql).toBe("SELECT * FROM t WHERE a = ? AND r IN (?, ?) AND s = ':not_param'");
    expect(b.values).toEqual([1, "N", "S"]);
  });
  it("mssql named", () => {
    const b = bindParams("SELECT * FROM t WHERE a = :a AND b = :a", { a: 5 }, "mssql");
    expect(b.sql).toBe("SELECT * FROM t WHERE a = @p0 AND b = @p1");
    expect(b.named).toEqual({ p0: 5, p1: 5 });
  });
  it("oracle named, trailing semicolon stripped, empty array", () => {
    const b = bindParams("SELECT * FROM t WHERE r IN (:r);", { r: [] }, "oracle");
    expect(b.sql).toBe("SELECT * FROM t WHERE r IN (NULL)");
  });
  it("postgres casts are not params", () => {
    const b = bindParams("SELECT x::date FROM t WHERE y = :y", { y: 1 }, "postgres");
    expect(b.sql).toBe("SELECT x::date FROM t WHERE y = $1");
  });
  it("missing param throws", () => {
    expect(() => bindParams("SELECT :x", {}, "mysql")).toThrow(/Missing/);
  });
});
