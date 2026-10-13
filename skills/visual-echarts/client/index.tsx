import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import type { ClientSkillModule, Frame, WidgetDefinition, WidgetRenderProps } from "@aibi/runtime-api";
import type { BuildCtx, Built, EvParams } from "./base";
import { buildCartesian } from "./cartesian";
import {
  buildBoxplot,
  buildCandlestick,
  buildFunnel,
  buildGauge,
  buildHeatmap,
  buildMap,
  buildPie,
  buildRadar,
  buildSankey,
  buildScatter,
  buildTreemap,
  buildWaterfall,
} from "./charts";
import { buildRaw } from "./raw";
import { deepMerge, isPlain, keyOf, strArr, type Obj } from "./util";
import "./styles.css";

/** Component types replaced (matched by id) on every update, so removed series/axes disappear while kept ones animate. */
const REPLACE_MERGE = [
  "series",
  "xAxis",
  "yAxis",
  "dataZoom",
  "visualMap",
  "graphic",
  "radar",
  "legend",
  "grid",
  "title",
  "dataset",
  "geo",
  "polar",
  "angleAxis",
  "radiusAxis",
  "singleAxis",
  "parallel",
  "parallelAxis",
  "calendar",
] as const;

const RAMP_COLORS = new Set(["echarts.heatmap", "echarts.map", "echarts.waterfall"]);

function build(type: string, ctx: BuildCtx, rawOption: unknown): Built {
  switch (type) {
    case "echarts.bar":
      return buildCartesian(ctx, "bar");
    case "echarts.line":
      return buildCartesian(ctx, "line");
    case "echarts.area":
      return buildCartesian(ctx, "area");
    case "echarts.combo":
      return buildCartesian(ctx, "combo");
    case "echarts.pie":
      return buildPie(ctx);
    case "echarts.scatter":
      return buildScatter(ctx);
    case "echarts.heatmap":
      return buildHeatmap(ctx);
    case "echarts.treemap":
      return buildTreemap(ctx, false);
    case "echarts.sunburst":
      return buildTreemap(ctx, true);
    case "echarts.sankey":
      return buildSankey(ctx);
    case "echarts.funnel":
      return buildFunnel(ctx);
    case "echarts.gauge":
      return buildGauge(ctx);
    case "echarts.radar":
      return buildRadar(ctx);
    case "echarts.waterfall":
      return buildWaterfall(ctx);
    case "echarts.boxplot":
      return buildBoxplot(ctx);
    case "echarts.candlestick":
      return buildCandlestick(ctx);
    case "echarts.map":
      return buildMap(ctx);
    case "echarts.raw":
      return buildRaw(ctx, rawOption);
    default:
      return { option: {}, message: `Unknown chart type ${type}` };
  }
}

function seriesIndexes(chart: echarts.ECharts): number[] {
  const series = (chart.getOption()?.series ?? []) as unknown[];
  return series.map((_, i) => i);
}

function EChartsWidget(rp: WidgetRenderProps) {
  const { widget, props, data, datasets, theme, width, height, api, format, editMode } = rp;
  const type = widget.type;
  const isRaw = type === "echarts.raw";
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const builtRef = useRef<Built | null>(null);
  const emitRef = useRef(rp.emit);
  emitRef.current = rp.emit;
  const setHandleRef = useRef(rp.setHandle);
  setHandleRef.current = rp.setHandle;
  const [renderError, setRenderError] = useState<string | null>(null);

  const propsKey = JSON.stringify(props);
  const themeKey = JSON.stringify(theme);
  const filtersKey = isRaw ? JSON.stringify(api.filters.values) : "";

  const built = useMemo<Built | null>(() => {
    const frame: Frame | undefined = data ?? (isRaw && !widget.dataset ? { columns: [], rows: [] } : undefined);
    if (!frame) return null;
    if (!isRaw && frame.rows.length === 0) return { option: {}, message: "No data" };
    const custom = RAMP_COLORS.has(type) ? [] : strArr(props.colors);
    const colors = custom.length ? custom : theme.palette.length ? theme.palette : [theme.accent];
    const fmtFor = (c: string | undefined): string | undefined => {
      if (!c) return undefined;
      const f = props.format;
      if (typeof f === "string") return f;
      if (isPlain(f) && typeof f[c] === "string") return f[c] as string;
      return undefined;
    };
    const ctx: BuildCtx = {
      type,
      props,
      frame,
      rows: frame.rows,
      theme,
      colors,
      fmt: format,
      fmtFor,
      width,
      height,
      editMode,
      api,
      datasets,
    };
    try {
      const b = build(type, ctx, props.option);
      if (!isRaw && isPlain(props.option)) b.option = deepMerge(b.option, props.option) as Obj; // `option` prop deep-merged over the generated one
      return b;
    } catch (e) {
      return { option: {}, message: `Could not build the chart: ${(e as Error).message}` };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, propsKey, data, themeKey, width, height, editMode, isRaw ? datasets : null, filtersKey]);

  // one chart instance per widget
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const handler = (event: "click" | "dblclick" | "hover") => (raw: unknown) => {
      const p = raw as EvParams;
      if (p.componentType && p.componentType !== "series") return;
      const b = builtRef.current;
      const row = b?.rowFor?.(p);
      const series = p.seriesIndex !== undefined ? (b?.seriesKeys?.[p.seriesIndex] ?? p.seriesName) : p.seriesName;
      const name = p.dataIndex >= 0 && b?.categories?.[p.dataIndex] !== undefined ? b.categories[p.dataIndex] : p.name;
      const value = type === "echarts.heatmap" && Array.isArray(p.value) ? p.value[2] : p.value;
      emitRef.current(event, { row, value, name, series });
    };
    chart.on("click", handler("click"));
    chart.on("dblclick", handler("dblclick"));
    chart.on("mouseover", handler("hover"));

    setHandleRef.current({
      setOption: (opt: unknown) => {
        if (isPlain(opt)) chartRef.current?.setOption(opt as echarts.EChartsOption);
      },
      highlight: (names: unknown) => {
        const c = chartRef.current;
        if (!c) return;
        const list = Array.isArray(names) ? names.map(keyOf) : names === undefined || names === null ? [] : [keyOf(names)];
        const seriesIndex = seriesIndexes(c);
        c.dispatchAction({ type: "downplay", seriesIndex });
        const cats = builtRef.current?.categories;
        for (const n of list) {
          const idx = cats ? cats.indexOf(n) : -1;
          if (idx >= 0) c.dispatchAction({ type: "highlight", seriesIndex, dataIndex: idx });
          else c.dispatchAction({ type: "highlight", seriesIndex, name: n });
        }
      },
      downplay: () => {
        const c = chartRef.current;
        if (c) c.dispatchAction({ type: "downplay", seriesIndex: seriesIndexes(c) });
      },
      showTip: (index: unknown) => {
        const i = Number(index);
        chartRef.current?.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: Number.isFinite(i) ? i : 0 });
      },
      getInstance: () => chartRef.current,
    });

    return () => {
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // apply the option (merge → animated updates) and keep the canvas sized to the box
  useEffect(() => {
    const chart = chartRef.current;
    builtRef.current = built;
    if (!chart) return;
    chart.resize();
    if (!built || built.message) {
      chart.clear();
      setRenderError(null);
      return;
    }
    try {
      chart.setOption(built.option as echarts.EChartsOption, { replaceMerge: [...REPLACE_MERGE] });
      setRenderError(null);
    } catch (e) {
      chart.clear();
      setRenderError((e as Error).message);
    }
  }, [built]);

  const message = renderError ? `Could not draw the chart: ${renderError}` : built?.message;
  const isEmpty = message === "No data";

  return (
    <div className="aibi-chart" style={{ height: height > 0 ? height : "100%", ["--aibi-r" as string]: `${theme.radius}px` }}>
      <div ref={elRef} className="aibi-chart-canvas" />
      {message && (
        <div className={isEmpty ? "aibi-chart-empty" : "aibi-chart-msg"} role="status">
          {!isEmpty && <span className="aibi-chart-msg-icon" aria-hidden="true">!</span>}
          <span>{message}</span>
        </div>
      )}
    </div>
  );
}

const TYPES = [
  "echarts.bar",
  "echarts.line",
  "echarts.area",
  "echarts.combo",
  "echarts.pie",
  "echarts.scatter",
  "echarts.heatmap",
  "echarts.treemap",
  "echarts.sunburst",
  "echarts.sankey",
  "echarts.funnel",
  "echarts.gauge",
  "echarts.radar",
  "echarts.waterfall",
  "echarts.boxplot",
  "echarts.candlestick",
  "echarts.map",
  "echarts.raw",
];

const widgets: WidgetDefinition[] = TYPES.map((type) => ({ type, component: EChartsWidget }));

const mod: ClientSkillModule = { widgets };
export default mod;
