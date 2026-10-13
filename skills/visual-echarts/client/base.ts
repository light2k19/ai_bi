import type { Frame, PageApi, ThemeTokens } from "@aibi/runtime-api";
import { axisSpec, isPlain, withAlpha, type Obj, type Row } from "./util";

/** Parameters ECharts passes to event handlers and formatters (the subset we use). */
export interface EvParams {
  componentType?: string;
  seriesType?: string;
  seriesIndex?: number;
  seriesName?: string;
  seriesId?: string;
  dataIndex: number;
  dataType?: string;
  name?: string;
  value?: unknown;
  data?: unknown;
  percent?: number;
  color?: string;
  marker?: string;
  axisValue?: unknown;
  axisValueLabel?: string;
  treePathInfo?: { name: string; value: unknown }[];
}

export interface BuildCtx {
  type: string;
  props: Obj;
  frame: Frame;
  rows: Row[];
  theme: ThemeTokens;
  colors: string[];
  fmt: (v: unknown, spec?: string) => string;
  /** format spec for a column (props.format string or { column: spec }) */
  fmtFor: (col: string | undefined) => string | undefined;
  width: number;
  height: number;
  editMode: boolean;
  api: PageApi;
  datasets: Record<string, Frame | undefined>;
}

export interface Built {
  option: Obj;
  /** source row behind a clicked/hovered element */
  rowFor?: (p: EvParams) => Row | undefined;
  /** raw category values in display order (for highlight by name) */
  categories?: string[];
  /** series key emitted with events (column or group value), by series index */
  seriesKeys?: string[];
  /** a message shown instead of the chart */
  message?: string;
}

export function hasColumn(frame: Frame, col: string | undefined): col is string {
  return !!col && frame.columns.some((c) => c.name === col);
}

export function numericCols(frame: Frame, exclude: (string | undefined)[] = []): string[] {
  const ex = new Set(exclude.filter(Boolean));
  return frame.columns.filter((c) => c.type === "number" && !ex.has(c.name)).map((c) => c.name);
}

export function firstCategoryCol(frame: Frame): string | undefined {
  return frame.columns.find((c) => c.type !== "number")?.name ?? frame.columns[0]?.name;
}

export function baseOption(theme: ThemeTokens, colors: string[]): Obj {
  return {
    backgroundColor: "transparent",
    color: colors,
    textStyle: { fontFamily: theme.fontFamily, color: theme.text },
    animationDuration: 800,
    animationDurationUpdate: 550,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicInOut",
    tooltip: tooltipStyle(theme),
  };
}

export function tooltipStyle(theme: ThemeTokens): Obj {
  return {
    confine: true,
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: theme.text, fontSize: 12, fontFamily: theme.fontFamily },
    extraCssText: `border-radius:${theme.radius}px;box-shadow:0 8px 24px rgba(0,0,0,${theme.mode === "dark" ? 0.45 : 0.12});`,
    axisPointer: {
      lineStyle: { color: theme.muted, width: 1, type: "dashed" },
      shadowStyle: { color: withAlpha(theme.muted, theme.mode === "dark" ? 0.14 : 0.08) },
      crossStyle: { color: theme.muted },
      label: { backgroundColor: theme.surface2, color: theme.text, borderColor: theme.border, borderWidth: 1 },
    },
  };
}

export type LegendPos = "top" | "bottom" | "right" | false;

/** props.legend: false hides, "top" | "bottom" | "right" positions; default `fallback`. */
export function legendPos(v: unknown, fallback: LegendPos): LegendPos {
  if (v === false) return false;
  if (v === "top" || v === "bottom" || v === "right") return v;
  if (v === true) return fallback || "top";
  return fallback;
}

export function legendOption(theme: ThemeTokens, pos: LegendPos, extra: Obj = {}): Obj {
  const placement: Obj = pos === "bottom" ? { bottom: 0, left: "center" } : pos === "right" ? { right: 0, top: "middle", orient: "vertical" } : { top: 0, left: "center" };
  return {
    show: pos !== false,
    type: "scroll",
    icon: "roundRect",
    itemWidth: 12,
    itemHeight: 8,
    itemGap: 16,
    textStyle: { color: theme.muted, fontSize: 12 },
    inactiveColor: theme.border,
    pageIconColor: theme.muted,
    pageIconInactiveColor: theme.border,
    pageTextStyle: { color: theme.muted },
    ...placement,
    ...extra,
  };
}

export function valueAxis(theme: ThemeTokens, fmt: BuildCtx["fmt"], spec: string | undefined, extra: Obj = {}): Obj {
  const s = axisSpec(spec);
  return {
    type: "value",
    axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => fmt(v, s), hideOverlap: true },
    splitLine: { lineStyle: { color: theme.border, type: "dashed" } },
    axisLine: { show: false },
    axisTick: { show: false },
    nameTextStyle: { color: theme.muted },
    ...extra,
  };
}

export function categoryAxis(theme: ThemeTokens, data: string[], extra: Obj = {}): Obj {
  return {
    type: "category",
    data,
    axisLine: { lineStyle: { color: theme.border } },
    axisTick: { show: false },
    axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true },
    splitLine: { show: false },
    nameTextStyle: { color: theme.muted },
    ...extra,
  };
}

/** Theme styling applied beneath a user-supplied axis (raw option). */
export function axisStyle(theme: ThemeTokens, isValue: boolean, formatter?: (v: number) => string): Obj {
  return {
    axisLine: { lineStyle: { color: theme.border } },
    axisTick: { lineStyle: { color: theme.border } },
    axisLabel: { color: theme.muted, fontSize: 11, ...(formatter ? { formatter } : {}) },
    splitLine: { lineStyle: { color: theme.border, type: isValue ? "dashed" : "solid" } },
    nameTextStyle: { color: theme.muted },
  };
}

export function sliderZoom(theme: ThemeTokens, horizontal: boolean, editMode: boolean): Obj[] {
  const common = horizontal ? { yAxisIndex: 0 } : { xAxisIndex: 0 };
  const slider: Obj = {
    type: "slider",
    ...common,
    ...(horizontal ? { right: 4, width: 16, top: 24, bottom: 24 } : { bottom: 6, height: 18, left: 48, right: 24 }),
    borderColor: theme.border,
    backgroundColor: "transparent",
    fillerColor: withAlpha(theme.accent, 0.12),
    handleStyle: { color: theme.surface, borderColor: theme.muted },
    moveHandleStyle: { color: theme.border },
    textStyle: { color: theme.muted, fontSize: 10 },
    dataBackground: { lineStyle: { color: theme.border }, areaStyle: { color: withAlpha(theme.muted, 0.12) } },
    selectedDataBackground: { lineStyle: { color: theme.accent }, areaStyle: { color: withAlpha(theme.accent, 0.18) } },
    brushSelect: false,
  };
  return editMode ? [slider] : [slider, { type: "inside", ...common, zoomOnMouseWheel: "shift", moveOnMouseWheel: false }];
}

/** Vertical gradient for area fills. */
export function areaGradient(color: string, top: number, bottom: number): Obj {
  return {
    type: "linear",
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: withAlpha(color, top) },
      { offset: 1, color: withAlpha(color, bottom) },
    ],
  };
}

export function valueOfParam(p: EvParams): unknown {
  return p.value;
}

/** Label style readable on any background (text colour with a halo of the surface colour). */
export function haloLabel(theme: ThemeTokens, extra: Obj = {}): Obj {
  return { color: theme.text, fontSize: 11, textBorderColor: theme.surface, textBorderWidth: 2, ...extra };
}

export function asObj(v: unknown): Obj {
  return isPlain(v) ? v : {};
}
