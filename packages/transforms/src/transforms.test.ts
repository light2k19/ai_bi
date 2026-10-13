import { describe, expect, it } from "vitest";
import { runPipeline, frameFromRows, toFrame, type Frame } from "./index";

const sales: Frame = frameFromRows([
  { region: "North", month: "2026-01", revenue: 100, target: 90 },
  { region: "North", month: "2026-02", revenue: 120, target: 100 },
  { region: "South", month: "2026-01", revenue: 80, target: 100 },
  { region: "South", month: "2026-03", revenue: 60, target: 70 },
]);

describe("transforms", () => {
  it("calc + filter + sort", () => {
    const f = runPipeline(sales, [
      { op: "calc", columns: { attainment: "safeDiv(revenue, target)" } },
      { op: "filter", where: "attainment >= 1" },
      { op: "sort", by: [{ column: "revenue", desc: true }] },
    ], { datasets: {} });
    expect(f.rows.map((r) => r.revenue)).toEqual([120, 100]);
    expect(f.columns.find((c) => c.name === "attainment")?.type).toBe("number");
  });
  it("aggregate with shorthand", () => {
    const f = runPipeline(sales, [{ op: "aggregate", groupBy: "region", measures: { revenue: "sum(revenue)", months: "count(month)" } }], { datasets: {} });
    expect(f.rows).toEqual([
      { region: "North", revenue: 220, months: 2 },
      { region: "South", revenue: 140, months: 2 },
    ]);
  });
  it("pivot and unpivot round trip", () => {
    const p = runPipeline(sales, [{ op: "pivot", index: "region", column: "month", value: "revenue", fill: 0 }], { datasets: {} });
    expect(p.rows[1]).toEqual({ region: "South", "2026-01": 80, "2026-02": 0, "2026-03": 60 });
    const u = runPipeline(p, [{ op: "unpivot", keep: ["region"], columns: ["2026-01"], nameAs: "month", valueAs: "rev" }], { datasets: {} });
    expect(u.rows).toEqual([
      { region: "North", month: "2026-01", rev: 100 },
      { region: "South", month: "2026-01", rev: 80 },
    ]);
  });
  it("join left with prefix on clash", () => {
    const targets = frameFromRows([{ region: "North", target: 1 }]);
    const f = runPipeline(frameFromRows([{ region: "North", target: 5 }, { region: "West", target: 2 }]), [{ op: "join", with: "t", on: "region", prefix: "t_" }], { datasets: { t: targets } });
    expect(f.rows).toEqual([
      { region: "North", target: 5, t_target: 1 },
      { region: "West", target: 2, t_target: null },
    ]);
  });
  it("fillGaps and periodCompare shift", () => {
    const f = runPipeline(sales, [
      { op: "filter", where: "region == 'South'" },
      { op: "fillGaps", column: "month", unit: "month", fill: 0 },
      { op: "periodCompare", dateColumn: "month", unit: "month", shift: 1, measures: ["revenue"] },
    ], { datasets: {} });
    expect(f.rows.map((r) => [r.month, r.revenue, r.prev_revenue])).toEqual([
      ["2026-01", 80, null],
      ["2026-02", 0, 80],
      ["2026-03", 60, 0],
    ]);
    expect(f.rows[1].revenue_pct).toBe(-1);
  });
  it("fillGaps fills each series and never drops rows", () => {
    // several rows per month (one per region) without groupBy: one series per region, all rows kept
    const f = runPipeline(sales, [{ op: "fillGaps", column: "month", unit: "month", fill: 0 }], { datasets: {} });
    expect(f.rows.map((r) => [r.region, r.month, r.revenue])).toEqual([
      ["North", "2026-01", 100],
      ["North", "2026-02", 120],
      ["North", "2026-03", 0],
      ["South", "2026-01", 80],
      ["South", "2026-02", 0],
      ["South", "2026-03", 60],
    ]);
    // an explicit empty groupBy fills one series; duplicates in a bucket are still all kept
    const one = runPipeline(sales, [{ op: "fillGaps", column: "month", unit: "month", fill: 0, groupBy: [] }], { datasets: {} });
    expect(one.rows).toHaveLength(4);
    // rows outside an explicit range are kept, not dropped
    const ranged = runPipeline(sales, [{ op: "fillGaps", column: "month", unit: "month", fill: 0, start: "2026-02", end: "2026-03", groupBy: "region" }], { datasets: {} });
    expect(ranged.rows.filter((r) => r.month === "2026-01")).toHaveLength(2);
  });
  it("topN with Other, rank, percentOfTotal, cumulative", () => {
    const f = runPipeline(sales, [
      { op: "topN", n: 2, by: "revenue", otherLabel: "Other", labelColumn: "region" },
      { op: "rank", by: "revenue" },
      { op: "percentOfTotal", column: "revenue", as: "share" },
      { op: "cumulative", column: "revenue", as: "cum" },
    ], { datasets: {} });
    expect(f.rows.map((r) => r.region)).toEqual(["North", "North", "Other"]);
    expect(f.rows[2].revenue).toBe(140);
    expect(f.rows.map((r) => r.rank)).toEqual([2, 3, 1]);
    expect(f.rows.map((r) => r.cum)).toEqual([120, 220, 360]);
  });
  it("errors name the step", () => {
    expect(() => runPipeline(sales, [{ op: "sort", by: "nope" }], { datasets: {} })).toThrow(/step 0 \(sort\).*'nope'/);
  });
  it("toFrame converts wire rows", () => {
    const f = toFrame({ columns: [{ name: "a", type: "number" }], rows: [[1], [2]] });
    expect(f.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
