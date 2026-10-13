import { describe, expect, it } from "vitest";
import { evaluate, ExprError } from "./expr";
import { resolveBindings, bindingPaths } from "./bindings";
import { filterValue, presetRange } from "./filters";
import { validatePage, sqlTables, bindingsInCodeFields } from "./validate";
import { checkCode } from "./code-check";
import { formatValue } from "./format";
import type { Catalogue } from "./catalogue";

describe("expr", () => {
  it("arithmetic, logic, functions", () => {
    expect(evaluate("revenue - target", { revenue: 10, target: 4 })).toBe(6);
    expect(evaluate("safeDiv(a, b)", { a: 1, b: 0 })).toBeNull();
    expect(evaluate("a > 1 and not b ? 'x' : 'y'", { a: 2, b: false })).toBe("x");
    expect(evaluate("round(1.2345, 2)", {})).toBe(1.23);
    expect(evaluate("rows.length", { rows: [1, 2, 3] })).toBe(3);
    expect(evaluate("sum(pluck(rows, 'v'))", { rows: [{ v: 1 }, { v: 2 }] })).toBe(3);
    expect(evaluate("x ?? 5", {})).toBe(5);
  });
  it("function names are case-insensitive", () => {
    expect(evaluate("ABS(x) + Round(1.26, 1)", { x: -2 })).toBe(3.3);
  });
  it("blocks prototype access and unknown functions", () => {
    expect(() => evaluate("a.constructor", { a: {} })).toThrow(ExprError);
    expect(() => evaluate("a['__proto__']", { a: {} })).toThrow(ExprError);
    expect(() => evaluate("alert(1)", {})).toThrow(/Unknown function/);
    expect(evaluate("toString", {})).toBeUndefined();
  });
});

describe("bindings", () => {
  it("keeps raw types for full bindings, interpolates text", () => {
    const scope = { filters: { region: { values: ["N", "S"] }, date: { start: "2026-01-01" } } };
    expect(resolveBindings({ r: "{{filters.region.values}}", t: "From {{filters.date.start}}" }, scope)).toEqual({
      r: ["N", "S"],
      t: "From 2026-01-01",
    });
    expect(bindingPaths({ a: "{{filters.date.start}}", b: "{{ filters.region.values.length > 0 }}" })).toEqual(
      expect.arrayContaining(["filters.date.start", "filters.region.values.length"]),
    );
  });
  it("supports formatter pipes", () => {
    const r = resolveBindings("Total {{ total | currency }}", { total: 1200 }, { currency: (v) => `$${v}` });
    expect(r).toBe("Total $1200");
  });
});

describe("filters", () => {
  it("date presets and derived ranges", () => {
    expect(presetRange("QTD", "2026-08-15")).toEqual({ start: "2026-07-01", end: "2026-08-15" });
    expect(presetRange("lastMonth", "2026-03-10")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    const v = filterValue({ id: "d", type: "dateRange" }, { preset: "MTD" }, { today: "2026-10-10" });
    expect(v).toMatchObject({ start: "2026-10-01", end: "2026-10-10", endExclusive: "2026-10-11", lyStart: "2025-10-01", lyEnd: "2025-10-10", days: 10, prevEnd: "2026-09-30", prevStart: "2026-09-21" });
  });
  it("multiSelect all", () => {
    expect(filterValue({ id: "r", type: "multiSelect" }, "all", { options: ["a", "b"] })).toEqual({ values: ["a", "b"], all: true, allFlag: 1 });
    expect(filterValue({ id: "r", type: "multiSelect" }, ["a"])).toEqual({ values: ["a"], all: false, allFlag: 0 });
  });
});

const catalogue: Catalogue = {
  widgets: [
    {
      type: "echarts.bar",
      skill: "visual-echarts",
      title: "Bar",
      description: "",
      needsDataset: true,
      columnProps: ["x", "series"],
      propsSchema: { type: "object", required: ["x", "series"], properties: { x: { type: "string" }, series: { type: "array", items: { type: "string" } } } },
    },
  ],
  transforms: [{ op: "calc", skill: "transform-core", description: "", schema: { type: "object", required: ["op", "columns"], properties: { op: { type: "string" }, columns: { type: "object" } } } }],
  filters: [{ type: "dateRange", skill: "filter-core", description: "", fields: [] }],
  scriptLibs: [],
  sources: [{ alias: "erp", name: "ERP", skill: "datasource-mysql", kind: "sql", dialect: "mysql" }],
  skills: { "visual-echarts": "1.0.0", "filter-core": "1.0.0", "datasource-mysql": "1.0.0", "transform-core": "1.0.0" },
  moduleHosts: ["esm.sh"],
};

const goodBundle = () => ({
  page: {
    id: "p1",
    title: "Revenue",
    filters: [{ id: "date", type: "dateRange", default: { preset: "YTD" } }],
    datasets: [
      {
        id: "rev",
        source: "erp",
        request: { sql: "SELECT region, SUM(amount) revenue FROM sales.orders WHERE sold_at >= :from AND sold_at < :to GROUP BY region", params: { from: "{{filters.date.start}}", to: "{{filters.date.endExclusive}}" } },
        pipeline: [{ op: "calc", columns: { k: "revenue / 1000" } }],
        columns: ["region", "revenue", "k"],
      },
    ],
    widgets: [{ id: "w1", type: "echarts.bar", dataset: "rev", grid: { x: 0, y: 0, w: 6, h: 6 }, props: { x: "region", series: ["revenue"] } }],
    modules: [{ name: "gsap", version: "3.12.5", source: "registry", registry: "esm.sh" }],
  },
  scripts: {},
  components: {},
});

describe("validatePage", () => {
  it("accepts a good page and computes requires/dependsOn", () => {
    const r = validatePage(goodBundle(), { catalogue });
    expect(r.errors).toEqual([]);
    expect(r.requires?.skills).toMatchObject({ "visual-echarts": "^1.0.0", "datasource-mysql": "^1.0.0", "filter-core": "^1.0.0" });
    expect(r.requires?.sources.erp.tables).toEqual(["sales.orders"]);
    expect(r.requires?.modules).toEqual({ gsap: "3.12.5" });
    expect(r.bundle?.page.datasets[0].dependsOn).toEqual(["filters.date"]);
  });
  it("reports precise errors", () => {
    const b = goodBundle();
    b.page.datasets[0].request.sql = "DELETE FROM sales.orders WHERE x = :from";
    (b.page.datasets[0].request.params as Record<string, string>).from = "{{filters.nope.start}}";
    b.page.widgets[0].props = { x: "region" } as never;
    b.page.widgets.push({ id: "w1", type: "echarts.pie", dataset: "zzz", grid: { x: 0, y: 6, w: 6, h: 4 }, props: { x: "a", series: [] } });
    b.page.modules[0].version = "^3";
    const r = validatePage(b, { catalogue });
    const msgs = r.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
    expect(msgs).toMatch(/Query must start with SELECT/);
    expect(msgs).toMatch(/no filter with id 'nope'/);
    expect(msgs).toMatch(/series: is required/);
    expect(msgs).toMatch(/id 'w1' is already used/);
    expect(msgs).toMatch(/unknown widget type 'echarts.pie'/);
    expect(msgs).toMatch(/no dataset 'zzz'/);
    expect(msgs).toMatch(/exact version/);
  });
  it("warns about unknown columns when dataset columns are known", () => {
    const b = goodBundle();
    b.page.widgets[0].props = { x: "regionz", series: ["revenue"] };
    const r = validatePage(b, { catalogue });
    expect(r.warnings.some((w) => /column 'regionz'/.test(w.message))).toBe(true);
  });
  it("detects dataset cycles", () => {
    const b = goodBundle() as ReturnType<typeof goodBundle> & { page: { datasets: unknown[] } };
    b.page.datasets.push({ id: "a", from: ["b"] } as never, { id: "b", from: ["a"] } as never);
    const r = validatePage(b, { catalogue });
    expect(r.errors.some((e) => /circular/.test(e.message))).toBe(true);
  });
  it("extracts tables ignoring CTE names", () => {
    expect(sqlTables("WITH x AS (SELECT * FROM a.t1) SELECT * FROM x JOIN t2 ON 1=1", "mysql")).toEqual(["a.t1", "t2"]);
  });
});

describe("checkCode", () => {
  it("flags banned APIs and undeclared imports", () => {
    const issues = checkCode(`import x from "lodash";\nexport default function(){ fetch('/x'); window.parent.postMessage(1) }`, { kind: "script", modules: [] });
    const m = issues.map((i) => i.message).join("\n");
    expect(m).toMatch(/fetch\(\) is not available/);
    expect(m).toMatch(/host window/);
    expect(m).toMatch(/import 'lodash' is not declared/);
  });
  it("ignores banned words in strings and comments", () => {
    expect(checkCode(`// fetch(x)\nimport { animate } from "@aibi/anim";\nexport default function(){ const s = "fetch(1)"; }`, { kind: "script", modules: [] })).toEqual([]);
  });
});

describe("formatValue", () => {
  it("formats common specs", () => {
    expect(formatValue(1234.5, "currency")).toBe("$1,235");
    expect(formatValue(0.256, "percent")).toBe("25.6%");
    expect(formatValue(1500000, "compact")).toBe("1.5M");
    expect(formatValue("2026-03-01", "month")).toMatch(/Mar 2026/);
  });
});

describe("bindings in query code", () => {
  it("are rejected in sql, path and GraphQL query text", () => {
    const b = goodBundle();
    b.page.datasets[0].request.sql = "SELECT * FROM sales.orders WHERE region = '{{filters.date.start}}'";
    const r = validatePage(b, { catalogue });
    expect(r.errors.some((e) => /not allowed inside 'sql'/.test(e.message))).toBe(true);
    expect(bindingsInCodeFields({ path: "/x/{{filters.a.value}}", query: { a: "{{filters.a.value}}" } })).toEqual(["path"]);
    expect(bindingsInCodeFields({ query: "query { a(x: \"{{filters.a.value}}\") { b } }" })).toEqual(["query"]);
  });
});
