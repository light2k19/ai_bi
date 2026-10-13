import { resolveBindings } from "@aibi/page-spec";
import { axisStyle, baseOption, legendOption, type BuildCtx, type Built } from "./base";
import { deepMerge, isPlain, type Obj, type Row } from "./util";

/** echarts.raw: resolve {{ }} bindings in props.option and theme it underneath. */
export function buildRaw(ctx: BuildCtx, rawOption: unknown): Built {
  const { theme, fmt, frame } = ctx;
  if (!isPlain(rawOption)) return { option: {}, message: "Set `option` to an ECharts option object." };
  const rows: Row[] = frame.rows;
  const names = frame.columns.map((c) => c.name);
  const colArrays: Record<string, unknown[]> = {};
  for (const n of names) colArrays[n] = rows.map((r) => r[n]);
  const scope: Record<string, unknown> = {
    col: colArrays,
    rows,
    row: rows[0] ?? {},
    source: [names, ...rows.map((r) => names.map((n) => r[n]))],
    filters: ctx.api.filters.values,
    data: ctx.datasets,
  };
  let option: Obj;
  try {
    option = resolveBindings(rawOption, scope);
  } catch (e) {
    return { option: {}, message: `Invalid binding in option: ${(e as Error).message}` };
  }

  const valueFormat = typeof ctx.props.valueFormat === "string" ? ctx.props.valueFormat : undefined;
  const formatter = valueFormat ? (v: number) => fmt(v, valueFormat) : undefined;
  const base: Obj = baseOption(theme, ctx.colors);
  if (valueFormat) (base.tooltip as Obj).valueFormatter = (v: unknown) => (v === null || v === undefined ? "–" : fmt(v, valueFormat));
  if (option.legend !== undefined) base.legend = legendOption(theme, "top");
  if (option.title !== undefined) base.title = { textStyle: { color: theme.text, fontSize: 14, fontWeight: 600 }, subtextStyle: { color: theme.muted } };

  const out = deepMerge(base, option) as Obj;
  for (const key of ["xAxis", "yAxis"] as const) {
    const ax = out[key];
    if (ax === undefined) continue;
    const style = (a: unknown): unknown => {
      if (!isPlain(a)) return a;
      const isValue = a.type === "value" || (a.type === undefined && key === "yAxis");
      return deepMerge(axisStyle(theme, isValue, isValue ? formatter : undefined), a);
    };
    out[key] = Array.isArray(ax) ? ax.map(style) : style(ax);
  }
  if (out.grid === undefined) out.grid = { left: 8, right: 16, top: out.legend ? 36 : 16, bottom: 8, containLabel: true };

  return {
    option: out,
    rowFor: (p) => (p.dataIndex >= 0 ? rows[p.dataIndex] : undefined),
  };
}
