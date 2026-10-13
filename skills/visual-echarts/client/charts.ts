import * as echarts from "echarts";
import type { ThemeTokens } from "@aibi/runtime-api";
import {
  baseOption,
  categoryAxis,
  firstCategoryCol,
  haloLabel,
  hasColumn,
  legendOption,
  legendPos,
  numericCols,
  sliderZoom,
  valueAxis,
  type BuildCtx,
  type Built,
  type EvParams,
} from "./base";
import { axisSpec, clamp, detectXFormat, escapeHtml, humanize, isPlain, keyOf, niceCeil, niceStep, objArr, str, strArr, toNum, withAlpha, type Obj, type Row } from "./util";

/** Text colour for labels drawn on saturated fills. */
function onColor(theme: ThemeTokens): string {
  return theme.mode === "dark" ? theme.text : theme.surface;
}

function col(ctx: BuildCtx, v: unknown, fallback?: string): string | undefined {
  const s = str(v);
  return hasColumn(ctx.frame, s) ? s : fallback;
}

function needCols(...cols: [string, string | undefined][]): string | undefined {
  const missing = cols.filter(([, c]) => !c).map(([n]) => `\`${n}\``);
  return missing.length ? `Set ${missing.join(", ")} to a column of the dataset.` : undefined;
}

function rowFromData(p: EvParams): Row | undefined {
  return isPlain(p.data) && isPlain(p.data.aibiRow) ? (p.data.aibiRow as Row) : undefined;
}

function tipLine(marker: string | undefined, name: unknown, value: string): string {
  return `<div style="display:flex;gap:16px;justify-content:space-between;align-items:center"><span>${marker ?? ""}${escapeHtml(name)}</span><b>${escapeHtml(value)}</b></div>`;
}

function aggregate(values: unknown[], how: string | undefined): number | null {
  const nums = values.map(toNum).filter((v): v is number => v !== null);
  if (!nums.length) return how === "count" ? 0 : null;
  switch (how) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "last":
      return nums[nums.length - 1];
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
    case "count":
      return values.length;
    default:
      return nums[0];
  }
}

/* ───────────────────────── pie ───────────────────────── */

export function buildPie(ctx: BuildCtx): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const nameCol = col(ctx, p.name, firstCategoryCol(ctx.frame));
  const valueCol = col(ctx, p.value, numericCols(ctx.frame, [nameCol])[0]);
  const msg = needCols(["name", nameCol], ["value", valueCol]);
  if (msg) return { option: {}, message: msg };
  const spec = ctx.fmtFor(valueCol);

  const byName = new Map<string, { name: string; value: number; row: Row }>();
  for (const r of rows) {
    const k = keyOf(r[nameCol!]);
    const v = toNum(r[valueCol!]) ?? 0;
    const e = byName.get(k);
    if (e) e.value += v;
    else byName.set(k, { name: k === "" ? "(blank)" : k, value: v, row: r });
  }
  let items = [...byName.values()];
  const topN = toNum(p.topN);
  if (topN && topN > 0 && items.length > topN) {
    const sorted = [...items].sort((a, b) => b.value - a.value);
    const keep = sorted.slice(0, topN);
    const rest = sorted.slice(topN);
    items = [...keep, { name: str(p.otherLabel) ?? "Other", value: rest.reduce((s, e) => s + e.value, 0), row: { [nameCol!]: str(p.otherLabel) ?? "Other", [valueCol!]: rest.reduce((s, e) => s + e.value, 0) } }];
  }

  const mode = p.labels === false ? "none" : p.labels === true ? "both" : p.labels === "value" || p.labels === "name" ? p.labels : p.labels === "percent" ? "percent" : "percent";
  const lp = legendPos(p.legend, mode === "name" || mode === "both" ? false : "bottom");
  const legendH = lp === "bottom" || lp === "top" ? 30 : 0;
  const legendW = lp === "right" ? Math.min(160, ctx.width * 0.35) : 0;
  const availW = ctx.width - legendW;
  const availH = ctx.height - legendH;
  const cx = availW / 2;
  const cy = (lp === "top" ? legendH : 0) + availH / 2;
  const outside = mode !== "none";
  const outer = Math.max(20, (Math.min(availW, availH) / 2) * (outside ? (mode === "both" || mode === "name" ? 0.66 : 0.76) : 0.9));
  const donut = p.donut === true;
  const inner = donut ? outer * 0.62 : 0;

  const pct = (v: number) => fmt(v / 100, v < 10 ? "percent:1" : "percent:0");
  const labelText = (pp: EvParams): string => {
    const percent = pct(pp.percent ?? 0);
    if (mode === "percent") return percent;
    if (mode === "value") return fmt(pp.value, axisSpec(spec));
    if (mode === "name") return keyOf(pp.name);
    return `{n|${keyOf(pp.name)}}\n{v|${percent}}`;
  };

  const option: Obj = {
    ...baseOption(theme, ctx.colors),
    legend: legendOption(theme, lp, lp === "right" ? { width: legendW - 8 } : {}),
    series: [
      {
        id: "pie",
        type: "pie",
        radius: [inner, outer],
        center: [cx, cy],
        roseType: p.rose === true ? "radius" : undefined,
        startAngle: 90,
        avoidLabelOverlap: true,
        data: items.map((e) => ({ name: e.name, value: e.value, aibiRow: e.row })),
        itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: donut ? 6 : 3 },
        label: {
          show: outside,
          position: "outside",
          formatter: labelText,
          color: theme.text,
          fontSize: 12,
          rich: { n: { color: theme.muted, fontSize: 11, lineHeight: 16 }, v: { color: theme.text, fontSize: 12, fontWeight: 600, lineHeight: 16 } },
        },
        labelLine: { show: outside, length: 8, length2: 10, smooth: true, lineStyle: { color: theme.border } },
        labelLayout: { hideOverlap: true },
        emphasis: { scale: true, scaleSize: 6, label: { fontWeight: 600 } },
        tooltip: {
          trigger: "item",
          formatter: (pp: EvParams) => `${tipLine(pp.marker, pp.name, fmt(pp.value, spec))}<div style="color:${theme.muted};text-align:right">${pct(pp.percent ?? 0)} of total</div>`,
        },
      },
    ],
  };

  const center = str(p.centerLabel);
  if (donut && center) {
    const lines = center.split("\n");
    const size = clamp(inner * (lines.length > 1 ? 0.26 : 0.34), 11, 28);
    option.graphic = [
      {
        type: "text",
        id: "center",
        silent: true,
        x: cx,
        y: cy,
        style: {
          text: center,
          fill: theme.text,
          align: "center",
          verticalAlign: "middle",
          textAlign: "center",
          textVerticalAlign: "middle",
          fontSize: size,
          fontWeight: 650,
          fontFamily: theme.fontFamily,
          lineHeight: size * 1.25,
        },
      },
    ];
  } else option.graphic = [{ type: "text", id: "center", invisible: true, silent: true, style: { text: "" } }];

  return { option, categories: items.map((e) => e.name), rowFor: rowFromData };
}

/* ───────────────────────── scatter ───────────────────────── */

export function buildScatter(ctx: BuildCtx): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const nums = numericCols(ctx.frame);
  const x = col(ctx, p.x, nums[0]);
  const y = col(ctx, p.y, nums[1]);
  const msg = needCols(["x", x], ["y", y]);
  if (msg) return { option: {}, message: msg };
  const size = col(ctx, p.size);
  const groupBy = col(ctx, p.groupBy);
  const label = col(ctx, p.label);
  const xSpec = str(p.xFormat) ?? ctx.fmtFor(x);
  const ySpec = str(p.yFormat) ?? ctx.fmtFor(y);
  const sSpec = ctx.fmtFor(size);

  const sizes = size ? rows.map((r) => toNum(r[size])).filter((v): v is number => v !== null) : [];
  const sMin = sizes.length ? Math.min(...sizes) : 0;
  const sMax = sizes.length ? Math.max(...sizes) : 0;
  const symbolSize = (val: unknown[]) => {
    if (!size) return 11;
    const v = toNum(val[2]);
    if (v === null) return 6;
    const t = sMax === sMin ? 0.5 : (v - sMin) / (sMax - sMin);
    return 8 + 34 * Math.sqrt(Math.max(0, t));
  };

  const groups = new Map<string, { name: string; rows: Row[] }>();
  for (const r of rows) {
    if (toNum(r[x!]) === null || toNum(r[y!]) === null) continue;
    const k = groupBy ? keyOf(r[groupBy]) : "__all";
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { name: groupBy ? k || "(blank)" : humanize(y!), rows: [] }));
    g.rows.push(r);
  }
  const groupList = [...groups.values()];
  const showLabels = !!label && rows.length <= 40;

  const series: Obj[] = groupList.map((g, i) => ({
    id: `s:${g.name}`,
    name: g.name,
    type: "scatter",
    data: g.rows.map((r) => [toNum(r[x!]), toNum(r[y!]), size ? toNum(r[size]) : null]),
    symbolSize,
    itemStyle: { opacity: 0.82, borderColor: theme.surface, borderWidth: 1, color: ctx.colors[i % ctx.colors.length] },
    emphasis: { focus: "series", scale: 1.15 },
    label: showLabels
      ? { show: true, position: "top", fontSize: 10, color: theme.muted, formatter: (pp: EvParams) => keyOf(g.rows[pp.dataIndex]?.[label!]) }
      : { show: false },
    labelLayout: { hideOverlap: true },
    tooltip: {
      trigger: "item",
      formatter: (pp: EvParams) => {
        const r = g.rows[pp.dataIndex] ?? {};
        const head = label ? keyOf(r[label]) : groupBy ? g.name : "";
        return [
          head ? `<div style="font-weight:600;margin-bottom:4px">${pp.marker ?? ""}${escapeHtml(head)}</div>` : "",
          tipLine("", humanize(x!), fmt(r[x!], xSpec)),
          tipLine("", humanize(y!), fmt(r[y!], ySpec)),
          size ? tipLine("", humanize(size), fmt(r[size], sSpec)) : "",
        ].join("");
      },
    },
  }));

  if (p.quadrants === true && series.length) {
    const xs = rows.map((r) => toNum(r[x!])).filter((v): v is number => v !== null);
    const ys = rows.map((r) => toNum(r[y!])).filter((v): v is number => v !== null);
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
    series[0].markLine = {
      silent: true,
      symbol: "none",
      lineStyle: { color: theme.muted, type: "dashed", width: 1 },
      label: { color: theme.muted, fontSize: 10, formatter: (pp: EvParams & { data?: { xAxis?: number } }) => (isPlain(pp.data) && "xAxis" in pp.data ? `avg ${fmt(pp.value, axisSpec(xSpec))}` : `avg ${fmt(pp.value, axisSpec(ySpec))}`) },
      data: [{ xAxis: avg(xs) }, { yAxis: avg(ys) }],
    };
  }

  const lp = legendPos(p.legend, groupList.length > 1 ? "top" : false);
  const option: Obj = {
    ...baseOption(theme, ctx.colors),
    legend: legendOption(theme, lp),
    grid: { left: 8, right: lp === "right" ? 128 : 20, top: (lp === "top" ? 36 : 12) + 18, bottom: (lp === "bottom" ? 30 : 0) + 22, containLabel: true },
    xAxis: valueAxis(theme, fmt, xSpec, { id: "x", scale: true, name: humanize(x!), nameLocation: "middle", nameGap: 26, nameTextStyle: { color: theme.muted, fontSize: 11 } }),
    yAxis: valueAxis(theme, fmt, ySpec, { id: "y", scale: true, name: humanize(y!), nameLocation: "end", nameGap: 10, nameTextStyle: { color: theme.muted, fontSize: 11, align: "left" } }),
    series,
  };
  (option.tooltip as Obj).trigger = "item";
  return { option, seriesKeys: groupList.map((g) => g.name), rowFor: (pp) => (pp.seriesIndex !== undefined ? groupList[pp.seriesIndex]?.rows[pp.dataIndex] : undefined) };
}

/* ───────────────────────── heatmap ───────────────────────── */

export function buildHeatmap(ctx: BuildCtx): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const x = col(ctx, p.x);
  const y = col(ctx, p.y);
  const v = col(ctx, p.value);
  const msg = needCols(["x", x], ["y", y], ["value", v]);
  if (msg) return { option: {}, message: msg };
  const spec = ctx.fmtFor(v);
  const xs: unknown[] = [];
  const ys: unknown[] = [];
  const xi = new Map<string, number>();
  const yi = new Map<string, number>();
  for (const r of rows) {
    if (!xi.has(keyOf(r[x!]))) (xi.set(keyOf(r[x!]), xs.length), xs.push(r[x!]));
    if (!yi.has(keyOf(r[y!]))) (yi.set(keyOf(r[y!]), ys.length), ys.push(r[y!]));
  }
  const xFormat = str(p.xFormat) ?? detectXFormat(xs);
  if (xFormat) {
    xs.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    xs.forEach((c, i) => xi.set(keyOf(c), i));
  }
  const cells = new Map<string, { v: number; row: Row }>();
  for (const r of rows) {
    const val = toNum(r[v!]);
    if (val === null) continue;
    const k = `${xi.get(keyOf(r[x!]))}|${yi.get(keyOf(r[y!]))}`;
    const c = cells.get(k);
    if (c) c.v += val;
    else cells.set(k, { v: val, row: r });
  }
  const data = [...cells.entries()].map(([k, c]) => {
    const [a, b] = k.split("|").map(Number);
    return { value: [a, b, c.v], aibiRow: c.row };
  });
  const vals = data.map((d) => d.value[2]);
  let min = vals.length ? Math.min(...vals) : 0;
  let max = vals.length ? Math.max(...vals) : 1;
  if (min === max) (min = Math.min(0, min), (max = max === min ? min + 1 : max));
  const ramp = strArr(p.colors).length >= 2 ? strArr(p.colors) : [withAlpha(theme.accent, theme.mode === "dark" ? 0.12 : 0.08), withAlpha(theme.accent, 0.55), theme.accent];
  const xLabels = xs.map((c) => (xFormat ? fmt(c, xFormat) : keyOf(c)));
  const yLabels = ys.map(keyOf);

  const option: Obj = {
    ...baseOption(theme, ctx.colors),
    grid: { left: 8, right: 12, top: 10, bottom: 44, containLabel: true },
    xAxis: categoryAxis(theme, xLabels, { id: "x", splitArea: { show: false }, axisLine: { show: false } }),
    yAxis: categoryAxis(theme, yLabels, { id: "y", inverse: true, axisLine: { show: false }, axisLabel: { color: theme.muted, fontSize: 11, width: Math.max(60, ctx.width * 0.22), overflow: "truncate" } }),
    visualMap: [
      {
        type: "continuous",
        min,
        max,
        calculable: true,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        itemWidth: 10,
        itemHeight: clamp(ctx.width * 0.4, 80, 240),
        inRange: { color: ramp },
        textStyle: { color: theme.muted, fontSize: 10 },
        formatter: (val: number) => fmt(val, axisSpec(spec)),
        handleStyle: { borderColor: theme.muted },
      },
    ],
    series: [
      {
        id: "heat",
        type: "heatmap",
        data,
        itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 3 },
        label: p.labels === true ? haloLabel(theme, { show: true, fontSize: 10, formatter: (pp: EvParams) => fmt((pp.value as unknown[])[2], axisSpec(spec)) }) : { show: false },
        emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1.5 } },
        tooltip: {
          formatter: (pp: EvParams) => {
            const val = pp.value as number[];
            return `<div style="color:${theme.muted};margin-bottom:2px">${escapeHtml(yLabels[val[1]])} · ${escapeHtml(xLabels[val[0]])}</div><b>${escapeHtml(fmt(val[2], spec))}</b>`;
          },
        },
      },
    ],
  };
  (option.tooltip as Obj).trigger = "item";
  return { option, rowFor: rowFromData };
}

/* ───────────────────────── treemap / sunburst ───────────────────────── */

interface TNode {
  name: string;
  value: number;
  children?: TNode[];
  aibiRow: Row;
  _kids?: Map<string, TNode>;
}

function buildTree(rows: Row[], path: string[], valueCol: string): { tree: TNode[]; depth: number } {
  const root: TNode = { name: "", value: 0, aibiRow: {}, _kids: new Map() };
  for (const r of rows) {
    const v = toNum(r[valueCol]) ?? 0;
    let node = root;
    root.value += v;
    const rowSoFar: Row = {};
    for (const c of path) {
      const k = keyOf(r[c]);
      rowSoFar[c] = r[c];
      node._kids ??= new Map();
      let child = node._kids.get(k);
      if (!child) node._kids.set(k, (child = { name: k === "" ? "(blank)" : k, value: 0, aibiRow: { ...rowSoFar } }));
      child.value += v;
      child.aibiRow[valueCol] = child.value;
      node = child;
    }
  }
  const finish = (n: TNode): TNode => {
    const out: TNode = { name: n.name, value: n.value, aibiRow: n.aibiRow };
    if (n._kids && n._kids.size) out.children = [...n._kids.values()].map(finish).sort((a, b) => b.value - a.value);
    return out;
  };
  return { tree: finish(root).children ?? [], depth: path.length };
}

function treeTooltip(ctx: BuildCtx, spec: string | undefined) {
  return (pp: EvParams) => {
    const path = (pp.treePathInfo ?? []).map((t) => t.name).filter(Boolean);
    const title = path.length ? path.join(" › ") : keyOf(pp.name);
    return `<div style="color:${ctx.theme.muted};margin-bottom:2px">${escapeHtml(title)}</div><b>${escapeHtml(ctx.fmt(pp.value, spec))}</b>`;
  };
}

export function buildTreemap(ctx: BuildCtx, sunburst: boolean): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const path = strArr(p.path).filter((c) => hasColumn(ctx.frame, c));
  const valueCol = col(ctx, p.value, numericCols(ctx.frame, path)[0]);
  if (!path.length || !valueCol) return { option: {}, message: needCols(["path", path[0]], ["value", valueCol]) ?? "Set `path` and `value`." };
  const spec = ctx.fmtFor(valueCol);
  const { tree, depth } = buildTree(rows, path, valueCol);
  const labelColor = onColor(theme);
  let series: Obj;
  if (!sunburst) {
    series = {
      id: "tree",
      name: "All",
      type: "treemap",
      data: tree,
      roam: false,
      nodeClick: depth > 1 ? "zoomToNode" : false,
      left: 2,
      right: 2,
      top: 2,
      bottom: depth > 1 ? 30 : 2,
      breadcrumb: {
        show: depth > 1,
        bottom: 4,
        left: 4,
        height: 20,
        itemStyle: { color: theme.surface2, borderColor: theme.border, textStyle: { color: theme.text } },
        emphasis: { itemStyle: { color: theme.border, textStyle: { color: theme.text } } },
      },
      label: {
        show: true,
        color: labelColor,
        fontSize: 12,
        overflow: "truncate",
        formatter: (pp: EvParams) => `{n|${keyOf(pp.name)}}\n{v|${fmt(pp.value, axisSpec(spec))}}`,
        rich: { n: { color: labelColor, fontSize: 12, fontWeight: 600, lineHeight: 16 }, v: { color: labelColor, fontSize: 11, lineHeight: 15, opacity: 0.9 } },
      },
      upperLabel: {
        show: depth > 1,
        height: 22,
        color: labelColor,
        fontSize: 11,
        fontWeight: 600,
        overflow: "truncate",
        formatter: (pp: EvParams) => `${keyOf(pp.name)}  ·  ${fmt(pp.value, axisSpec(spec))}`,
      },
      itemStyle: { borderColor: theme.surface, borderRadius: 3 },
      levels: [
        { itemStyle: { borderWidth: 0, gapWidth: 3 }, upperLabel: { show: false } },
        { itemStyle: { borderColor: theme.surface, borderWidth: depth > 1 ? 3 : 0, gapWidth: 2, borderRadius: 4 } },
        { colorSaturation: [0.35, 0.6], itemStyle: { gapWidth: 1, borderColorSaturation: 0.65, borderRadius: 2 } },
      ],
      tooltip: { formatter: treeTooltip(ctx, spec) },
    };
  } else {
    series = {
      id: "sun",
      type: "sunburst",
      data: tree,
      radius: [depth > 1 ? "16%" : "32%", "94%"],
      center: ["50%", "50%"],
      sort: undefined,
      nodeClick: "rootToNode",
      itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 4 },
      label: { rotate: "radial", color: labelColor, fontSize: 11, minAngle: 10, overflow: "truncate" },
      emphasis: { focus: "ancestor" },
      tooltip: { formatter: treeTooltip(ctx, spec) },
    };
  }
  const option: Obj = { ...baseOption(theme, ctx.colors), series: [series] };
  (option.tooltip as Obj).trigger = "item";
  return { option, rowFor: rowFromData };
}

/* ───────────────────────── sankey ───────────────────────── */

export function buildSankey(ctx: BuildCtx): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const s = col(ctx, p.source);
  const t = col(ctx, p.target);
  const v = col(ctx, p.value);
  const msg = needCols(["source", s], ["target", t], ["value", v]);
  if (msg) return { option: {}, message: msg };
  const spec = ctx.fmtFor(v);
  const nodes = new Map<string, true>();
  const links = new Map<string, { source: string; target: string; value: number; aibiRow: Row }>();
  for (const r of rows) {
    const a = keyOf(r[s!]);
    const b = keyOf(r[t!]);
    const val = toNum(r[v!]);
    if (!a || !b || a === b || val === null || val <= 0) continue;
    nodes.set(a, true);
    nodes.set(b, true);
    const k = `${a}\u0000${b}`;
    const l = links.get(k);
    if (l) l.value += val;
    else links.set(k, { source: a, target: b, value: val, aibiRow: { [s!]: r[s!], [t!]: r[t!], [v!]: val } });
  }
  for (const l of links.values()) l.aibiRow[v!] = l.value;
  const vertical = p.orient === "vertical";
  const option: Obj = {
    ...baseOption(theme, ctx.colors),
    series: [
      {
        id: "sankey",
        type: "sankey",
        orient: vertical ? "vertical" : "horizontal",
        left: 8,
        right: vertical ? 8 : Math.min(140, ctx.width * 0.22),
        top: 8,
        bottom: vertical ? 28 : 8,
        nodeAlign: "justify",
        nodeGap: 12,
        nodeWidth: 14,
        layoutIterations: 32,
        draggable: !ctx.editMode,
        data: [...nodes.keys()].map((name) => ({ name })),
        links: [...links.values()],
        emphasis: { focus: "adjacency" },
        lineStyle: { color: "gradient", curveness: 0.5, opacity: theme.mode === "dark" ? 0.35 : 0.3 },
        itemStyle: { borderWidth: 0, borderRadius: 2 },
        label: { color: theme.text, fontSize: 11, ...(vertical ? { position: "bottom" } : {}) },
        tooltip: {
          formatter: (pp: EvParams) => {
            if (pp.dataType === "edge" && isPlain(pp.data)) return tipLine("", `${keyOf(pp.data.source)} → ${keyOf(pp.data.target)}`, fmt(pp.value, spec));
            return tipLine(pp.marker, pp.name, fmt(pp.value, spec));
          },
        },
      },
    ],
  };
  (option.tooltip as Obj).trigger = "item";
  return { option, rowFor: rowFromData };
}

/* ───────────────────────── funnel ───────────────────────── */

export function buildFunnel(ctx: BuildCtx): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const nameCol = col(ctx, p.name, firstCategoryCol(ctx.frame));
  const valueCol = col(ctx, p.value, numericCols(ctx.frame, [nameCol])[0]);
  const msg = needCols(["name", nameCol], ["value", valueCol]);
  if (msg) return { option: {}, message: msg };
  const spec = ctx.fmtFor(valueCol);
  const items = rows.map((r) => ({ name: keyOf(r[nameCol!]), value: toNum(r[valueCol!]) ?? 0, aibiRow: r }));
  const first = items[0]?.value ?? 0;
  const conv = p.showConversion === true;
  const pctOf = (v: number, base: number) => (base ? fmt(v / base, "percent:0") : "–");
  const sort = p.sort === "ascending" || p.sort === "none" ? p.sort : "descending";
  const lp = legendPos(p.legend, false);
  const option: Obj = {
    ...baseOption(theme, ctx.colors),
    legend: legendOption(theme, lp),
    series: [
      {
        id: "funnel",
        type: "funnel",
        left: "6%",
        width: "88%",
        top: lp === "top" ? 36 : 8,
        bottom: lp === "bottom" ? 34 : 8,
        minSize: "12%",
        gap: 3,
        sort,
        data: items,
        label: {
          show: true,
          position: "inside",
          color: onColor(theme),
          fontSize: 12,
          lineHeight: 16,
          formatter: (pp: EvParams) => {
            const v = toNum(pp.value) ?? 0;
            return `${keyOf(pp.name)}\n${fmt(v, axisSpec(spec))}${conv ? ` · ${pctOf(v, first)}` : ""}`;
          },
        },
        labelLine: { show: false },
        itemStyle: { borderColor: theme.surface, borderWidth: 1 },
        emphasis: { label: { fontWeight: 600 } },
        tooltip: {
          formatter: (pp: EvParams) => {
            const v = toNum(pp.value) ?? 0;
            const prev = pp.dataIndex > 0 ? items[pp.dataIndex - 1]?.value : undefined;
            return [
              tipLine(pp.marker, pp.name, fmt(v, spec)),
              `<div style="color:${theme.muted}">${pctOf(v, first)} of ${escapeHtml(items[0]?.name)}</div>`,
              prev !== undefined ? `<div style="color:${theme.muted}">${pctOf(v, prev)} of previous stage</div>` : "",
            ].join("");
          },
        },
      },
    ],
  };
  (option.tooltip as Obj).trigger = "item";
  return { option, categories: items.map((i) => i.name), rowFor: rowFromData };
}

/* ───────────────────────── gauge ───────────────────────── */

export function buildGauge(ctx: BuildCtx): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const valueCol = col(ctx, p.value, numericCols(ctx.frame)[0]);
  if (!valueCol) return { option: {}, message: "Set `value` to a numeric column." };
  const how = str(p.aggregate) ?? "first";
  const value = aggregate(rows.map((r) => r[valueCol]), how) ?? 0;
  const spec = str(p.format) ?? ctx.fmtFor(valueCol);
  let target: number | null = null;
  if (typeof p.target === "number") target = p.target;
  else if (typeof p.target === "string") target = hasColumn(ctx.frame, p.target) ? aggregate(rows.map((r) => r[p.target as string]), how) : toNum(p.target);

  const isPct = (spec ?? "").startsWith("percent");
  const min = toNum(p.min) ?? 0;
  const top = Math.max(value, target ?? 0);
  let max = toNum(p.max) ?? (isPct ? Math.max(1, niceCeil(top * 1.1)) : niceCeil(top * 1.15));
  if (max <= min) max = min + 1;

  const start = 215;
  const end = -35;
  const sweep = start - end;
  const W = ctx.width;
  const H = ctx.height;
  const R = Math.max(24, Math.min((W / 2) * 0.92, (H - 8) / 1.62));
  const cx = W / 2;
  const cy = (H - 1.57 * R) / 2 + R;
  const lw = clamp(R * 0.15, 8, 26);

  const bandsIn = objArr(p.bands)
    .map((b) => [toNum(b.to), str(b.color)] as const)
    .filter((b): b is readonly [number, string] => b[0] !== null && !!b[1])
    .sort((a, b) => a[0] - b[0]);
  const bands: [number, string][] = bandsIn.map(([to, c]) => [clamp(to, 0, 1), c]);
  if (bands.length && bands[bands.length - 1][0] < 1) bands.push([1, theme.surface2]);
  const useBands = bands.length > 0;
  const accent = str(p.color) ?? ctx.colors[0] ?? theme.accent;

  const range = max - min;
  const near = (a: number, b: number) => Math.abs(a - b) <= range * 1e-6;
  const label = str(p.label);
  const targetText = target !== null ? `Target ${fmt(target, spec)}` : "";
  const name = [label, targetText].filter(Boolean).join(" · ");
  const detailSize = clamp(R * 0.3, 16, 44);

  const option: Obj = {
    ...baseOption(theme, ctx.colors),
    series: [
      {
        id: "gauge",
        type: "gauge",
        center: [cx, cy],
        radius: R,
        startAngle: start,
        endAngle: end,
        min,
        max,
        splitNumber: 4,
        axisLine: { roundCap: !useBands, lineStyle: { width: lw, color: useBands ? bands : [[1, theme.surface2]] } },
        progress: { show: !useBands, width: lw, roundCap: true, itemStyle: { color: accent } },
        pointer: useBands
          ? { show: true, length: "62%", width: clamp(R * 0.05, 3, 8), itemStyle: { color: theme.text } }
          : { show: false },
        anchor: useBands ? { show: true, size: clamp(R * 0.1, 8, 16), itemStyle: { color: theme.text, borderColor: theme.surface, borderWidth: 2 } } : { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          show: R > 50,
          distance: lw + 6,
          color: theme.muted,
          fontSize: 10,
          formatter: (v: number) => (near(v, min) || near(v, max) ? fmt(v, axisSpec(spec)) : ""),
        },
        title: { show: !!name, offsetCenter: [0, useBands ? "62%" : "34%"], color: theme.muted, fontSize: clamp(R * 0.1, 10, 13) },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, useBands ? "40%" : "4%"],
          fontSize: useBands ? detailSize * 0.75 : detailSize,
          fontWeight: 650,
          color: theme.text,
          fontFamily: theme.fontFamily,
          formatter: (v: number) => fmt(v, spec),
        },
        data: [{ value, name, aibiRow: rows[0] }],
        tooltip: { formatter: (pp: EvParams) => [tipLine(pp.marker, label ?? humanize(valueCol), fmt(pp.value, spec)), targetText ? `<div style="color:${theme.muted}">${escapeHtml(targetText)}</div>` : ""].join("") },
      },
    ],
  };
  (option.tooltip as Obj).trigger = "item";

  if (target !== null && target >= min && target <= max) {
    const deg = start - ((target - min) / range) * sweep;
    const rad = (deg * Math.PI) / 180;
    const r1 = R - lw - 5;
    const r2 = R + 5;
    option.graphic = [
      {
        type: "line",
        id: "target",
        silent: true,
        z: 100,
        shape: { x1: cx + r1 * Math.cos(rad), y1: cy - r1 * Math.sin(rad), x2: cx + r2 * Math.cos(rad), y2: cy - r2 * Math.sin(rad) },
        style: { stroke: theme.text, lineWidth: 3, lineCap: "round" },
      },
    ];
  } else option.graphic = [{ type: "line", id: "target", invisible: true, silent: true, shape: { x1: 0, y1: 0, x2: 0, y2: 0 } }];

  return { option, rowFor: () => rows[0] };
}

/* ───────────────────────── radar ───────────────────────── */

export function buildRadar(ctx: BuildCtx): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const nameCol = col(ctx, p.name, firstCategoryCol(ctx.frame));
  let measures = strArr(p.measures).filter((m) => hasColumn(ctx.frame, m));
  if (!measures.length) measures = numericCols(ctx.frame, [nameCol]);
  if (!nameCol || measures.length < 3) return { option: {}, message: "A radar needs a `name` column and at least 3 `measures`." };
  const maxFor = (m: string): number => {
    if (typeof p.max === "number") return p.max;
    if (isPlain(p.max) && toNum(p.max[m]) !== null) return toNum(p.max[m])!;
    const vals = rows.map((r) => toNum(r[m])).filter((v): v is number => v !== null);
    return Number((niceStep((Math.max(0, ...vals) * 1.05) / 5) * 5).toPrecision(12)); // divisible into 5 readable rings
  };
  const area = p.area !== false;
  const list = rows.slice(0, 12);
  const data = list.map((r, i) => {
    const c = ctx.colors[i % ctx.colors.length];
    return {
      name: keyOf(r[nameCol]),
      value: measures.map((m) => toNum(r[m]) ?? 0),
      aibiRow: r,
      itemStyle: { color: c },
      lineStyle: { color: c, width: 2 },
      areaStyle: area ? { color: withAlpha(c, 0.14) } : undefined,
    };
  });
  const lp = legendPos(p.legend, list.length > 1 ? "top" : false);
  const option: Obj = {
    ...baseOption(theme, ctx.colors),
    legend: legendOption(theme, lp),
    radar: [
      {
        id: "radar",
        center: ["50%", lp === "top" ? "56%" : lp === "bottom" ? "46%" : "50%"],
        radius: lp === "top" || lp === "bottom" ? "64%" : "70%",
        shape: "polygon",
        indicator: measures.map((m) => ({ name: humanize(m), max: maxFor(m) })),
        axisName: { color: theme.muted, fontSize: 11 },
        splitLine: { lineStyle: { color: theme.border } },
        axisLine: { lineStyle: { color: theme.border } },
        splitArea: { show: true, areaStyle: { color: ["transparent", withAlpha(theme.muted, theme.mode === "dark" ? 0.06 : 0.04)] } },
      },
    ],
    series: [
      {
        id: "radar",
        type: "radar",
        symbol: "circle",
        symbolSize: 5,
        data,
        emphasis: { lineStyle: { width: 3 } },
        tooltip: {
          formatter: (pp: EvParams) => {
            const vals = (pp.value as number[]) ?? [];
            return `<div style="font-weight:600;margin-bottom:4px">${pp.marker ?? ""}${escapeHtml(pp.name)}</div>${measures.map((m, i) => tipLine("", humanize(m), fmt(vals[i], ctx.fmtFor(m)))).join("")}`;
          },
        },
      },
    ],
  };
  (option.tooltip as Obj).trigger = "item";
  return { option, categories: data.map((d) => d.name), rowFor: rowFromData };
}

/* ───────────────────────── waterfall ───────────────────────── */

export function buildWaterfall(ctx: BuildCtx): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const x = col(ctx, p.x, firstCategoryCol(ctx.frame));
  const v = col(ctx, p.value, numericCols(ctx.frame, [x])[0]);
  const msg = needCols(["x", x], ["value", v]);
  if (msg) return { option: {}, message: msg };
  const spec = str(p.format) ?? ctx.fmtFor(v);
  const totals = new Set(strArr(p.totals));
  const totalCol = col(ctx, p.totalColumn);
  const colorsIn = isPlain(p.colors) ? p.colors : {};
  const cUp = str(colorsIn.up) ?? theme.success;
  const cDown = str(colorsIn.down) ?? theme.danger;
  const cTotal = str(colorsIn.total) ?? theme.accent;

  const base: (number | null)[] = [];
  const up: (number | null)[] = [];
  const upNeg: (number | null)[] = [];
  const down: (number | null)[] = [];
  const downNeg: (number | null)[] = [];
  const total: (number | null)[] = [];
  const info: { delta: number; end: number; isTotal: boolean }[] = [];
  let running = 0;
  for (const r of rows) {
    const val = toNum(r[v!]);
    const isTotal = totals.has(keyOf(r[x!])) || (!!totalCol && (r[totalCol] === true || r[totalCol] === 1 || r[totalCol] === "1" || r[totalCol] === "true"));
    base.push(null), up.push(null), upNeg.push(null), down.push(null), downNeg.push(null), total.push(null);
    const i = base.length - 1;
    if (isTotal) {
      const t = val ?? running;
      total[i] = t;
      info.push({ delta: t, end: t, isTotal: true });
      running = t;
      continue;
    }
    const d = val ?? 0;
    const startV = running;
    const endV = running + d;
    const lo = Math.min(startV, endV);
    const hi = Math.max(startV, endV);
    const pos = d >= 0;
    if (lo >= 0) {
      base[i] = lo;
      (pos ? up : down)[i] = hi - lo;
    } else if (hi <= 0) {
      base[i] = hi;
      (pos ? up : down)[i] = lo - hi;
    } else {
      (pos ? up : down)[i] = hi;
      (pos ? upNeg : downNeg)[i] = lo;
    }
    info.push({ delta: d, end: endV, isTotal: false });
    running = endV;
  }

  const cats = rows.map((r) => keyOf(r[x!]));
  const showLabels = p.labels !== false;
  const lblSpec = axisSpec(spec);
  const sign = (n: number) => (n > 0 ? "+" : "");
  const mkLabel = (kind: "up" | "down" | "total") =>
    showLabels
      ? haloLabel(theme, {
          show: true,
          position: kind === "down" ? "bottom" : "top",
          formatter: (pp: EvParams) => {
            const inf = info[pp.dataIndex];
            if (!inf) return "";
            return inf.isTotal ? fmt(inf.delta, lblSpec) : `${sign(inf.delta)}${fmt(inf.delta, lblSpec)}`;
          },
        })
      : { show: false };
  const bar = (id: string, data: (number | null)[], color: string, label: Obj | undefined, radius: number[]): Obj => ({
    id,
    name: id,
    type: "bar",
    stack: "wf",
    data,
    barMaxWidth: 48,
    barCategoryGap: "30%",
    itemStyle: { color, borderRadius: radius },
    label: label ?? { show: false },
    emphasis: { itemStyle: { shadowBlur: 10, shadowColor: withAlpha(theme.text, 0.25) } },
  });
  const option: Obj = {
    ...baseOption(theme, ctx.colors),
    grid: { left: 8, right: 16, top: 24, bottom: 4, containLabel: true },
    legend: { show: false },
    xAxis: categoryAxis(theme, cats, { id: "cat" }),
    yAxis: valueAxis(theme, fmt, spec, { id: "v0" }),
    series: [
      { ...bar("base", base, "transparent", undefined, [0, 0, 0, 0]), itemStyle: { color: "transparent", borderColor: "transparent" }, emphasis: { disabled: true }, silent: true, tooltip: { show: false } },
      bar("total", total, cTotal, mkLabel("total"), [4, 4, 0, 0]),
      bar("up", up, cUp, mkLabel("up"), [4, 4, 0, 0]),
      bar("down", down, cDown, mkLabel("down"), [4, 4, 0, 0]),
      bar("upNeg", upNeg, cUp, undefined, [0, 0, 4, 4]),
      bar("downNeg", downNeg, cDown, undefined, [0, 0, 4, 4]),
    ],
  };
  Object.assign(option.tooltip as Obj, {
    trigger: "axis",
    axisPointer: { ...((option.tooltip as Obj).axisPointer as Obj), type: "shadow" },
    formatter: (ps: EvParams[] | EvParams) => {
      const list = Array.isArray(ps) ? ps : [ps];
      const i = list[0]?.dataIndex ?? 0;
      const inf = info[i];
      if (!inf) return "";
      const color = inf.isTotal ? cTotal : inf.delta >= 0 ? cUp : cDown;
      const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:6px"></span>`;
      return [
        `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(cats[i])}</div>`,
        tipLine(dot, inf.isTotal ? "Total" : inf.delta >= 0 ? "Increase" : "Decrease", `${inf.isTotal ? "" : sign(inf.delta)}${fmt(inf.delta, spec)}`),
        inf.isTotal ? "" : tipLine("", "Running total", fmt(inf.end, spec)),
      ].join("");
    },
  });
  return { option, categories: cats, rowFor: (pp) => rows[pp.dataIndex] };
}

/* ───────────────────────── boxplot / candlestick ───────────────────────── */

export function buildBoxplot(ctx: BuildCtx): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const x = col(ctx, p.x, firstCategoryCol(ctx.frame));
  const keys = ["min", "q1", "median", "q3", "max"] as const;
  const cols = keys.map((k) => col(ctx, p[k]));
  const msg = needCols(["x", x], ...keys.map((k, i) => [k, cols[i]] as [string, string | undefined]));
  if (msg) return { option: {}, message: msg };
  const spec = str(p.format) ?? ctx.fmtFor(cols[2]);
  const cats = rows.map((r) => keyOf(r[x!]));
  const color = ctx.colors[0] ?? theme.accent;
  const option: Obj = {
    ...baseOption(theme, ctx.colors),
    grid: { left: 8, right: 16, top: 16, bottom: 4, containLabel: true },
    xAxis: categoryAxis(theme, cats, { id: "cat" }),
    yAxis: valueAxis(theme, fmt, spec, { id: "v0", scale: true }),
    series: [
      {
        id: "box",
        type: "boxplot",
        data: rows.map((r) => cols.map((c) => toNum(r[c!]))),
        boxWidth: [8, 44],
        itemStyle: { color: withAlpha(color, 0.18), borderColor: color, borderWidth: 1.5 },
        emphasis: { itemStyle: { color: withAlpha(color, 0.32), borderColor: color, borderWidth: 2 } },
        tooltip: {
          formatter: (pp: EvParams) => {
            const r = rows[pp.dataIndex] ?? {};
            return `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(cats[pp.dataIndex])}</div>${keys.map((k, i) => tipLine("", k === "q1" ? "Q1" : k === "q3" ? "Q3" : humanize(k), fmt(r[cols[i]!], spec))).join("")}`;
          },
        },
      },
    ],
  };
  (option.tooltip as Obj).trigger = "item";
  return { option, categories: cats, rowFor: (pp) => rows[pp.dataIndex] };
}

export function buildCandlestick(ctx: BuildCtx): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const x = col(ctx, p.x, firstCategoryCol(ctx.frame));
  const keys = ["open", "close", "low", "high"] as const;
  const cols = keys.map((k) => col(ctx, p[k], hasColumn(ctx.frame, k) ? k : undefined));
  const msg = needCols(["x", x], ...keys.map((k, i) => [k, cols[i]] as [string, string | undefined]));
  if (msg) return { option: {}, message: msg };
  const spec = str(p.format) ?? ctx.fmtFor(cols[1]);
  const raw = rows.map((r) => r[x!]);
  const xFormat = str(p.xFormat) ?? detectXFormat(raw);
  const cats = raw.map((c) => (xFormat ? fmt(c, xFormat) : keyOf(c)));
  const zoom = p.dataZoom === true;
  const option: Obj = {
    ...baseOption(theme, ctx.colors),
    grid: { left: 8, right: 16, top: 16, bottom: zoom ? 38 : 4, containLabel: true },
    xAxis: categoryAxis(theme, cats, { id: "cat" }),
    yAxis: valueAxis(theme, fmt, spec, { id: "v0", scale: true }),
    dataZoom: zoom ? sliderZoom(theme, false, ctx.editMode) : [],
    series: [
      {
        id: "k",
        type: "candlestick",
        data: rows.map((r) => cols.map((c) => toNum(r[c!]))),
        barMaxWidth: 18,
        itemStyle: { color: theme.success, color0: theme.danger, borderColor: theme.success, borderColor0: theme.danger },
      },
    ],
  };
  Object.assign(option.tooltip as Obj, {
    trigger: "axis",
    axisPointer: { ...((option.tooltip as Obj).axisPointer as Obj), type: "line" },
    formatter: (ps: EvParams[] | EvParams) => {
      const i = (Array.isArray(ps) ? ps[0] : ps)?.dataIndex ?? 0;
      const r = rows[i] ?? {};
      return `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(cats[i])}</div>${keys.map((k, j) => tipLine("", humanize(k), fmt(r[cols[j]!], spec))).join("")}`;
    },
  });
  return { option, categories: raw.map(keyOf), rowFor: (pp) => rows[pp.dataIndex] };
}

/* ───────────────────────── map ───────────────────────── */

const registeredMaps = new Map<string, string>();

function decodeAsset(text: string): string {
  if (!text.startsWith("data:")) return text;
  const comma = text.indexOf(",");
  const meta = text.slice(5, comma);
  const body = text.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const bin = atob(body);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(body);
}

export function buildMap(ctx: BuildCtx): Built {
  const { props: p, rows, theme, fmt } = ctx;
  const geo = str(p.geo);
  if (!geo) return { option: {}, message: "Set `geo` to a GeoJSON asset name." };
  const nameCol = col(ctx, p.name, firstCategoryCol(ctx.frame));
  const valueCol = col(ctx, p.value, numericCols(ctx.frame, [nameCol])[0]);
  const msg = needCols(["name", nameCol], ["value", valueCol]);
  if (msg) return { option: {}, message: msg };
  const asset = ctx.api.page.asset(geo);
  if (!asset) return { option: {}, message: `Map "${geo}" is not available. Add the GeoJSON file to the page assets.` };
  if (registeredMaps.get(geo) !== asset) {
    try {
      const geoJson = JSON.parse(decodeAsset(asset)) as Parameters<typeof echarts.registerMap>[1];
      echarts.registerMap(geo, geoJson);
      registeredMaps.set(geo, asset);
    } catch (e) {
      return { option: {}, message: `Map "${geo}" is not valid GeoJSON: ${(e as Error).message}` };
    }
  }
  const spec = ctx.fmtFor(valueCol);
  const byName = new Map<string, { value: number; row: Row }>();
  for (const r of rows) {
    const k = keyOf(r[nameCol!]);
    const v = toNum(r[valueCol!]);
    if (v === null) continue;
    const e = byName.get(k);
    if (e) e.value += v;
    else byName.set(k, { value: v, row: r });
  }
  const vals = [...byName.values()].map((e) => e.value);
  const min = vals.length ? Math.min(...vals) : 0;
  let max = vals.length ? Math.max(...vals) : 1;
  if (max === min) max = min + 1;
  const ramp = strArr(p.colors).length >= 2 ? strArr(p.colors) : [withAlpha(theme.accent, 0.15), theme.accent];
  const option: Obj = {
    ...baseOption(theme, ctx.colors),
    visualMap: [
      {
        type: "continuous",
        min,
        max,
        calculable: true,
        orient: "vertical",
        left: 8,
        bottom: 8,
        itemWidth: 10,
        itemHeight: clamp(ctx.height * 0.3, 60, 160),
        inRange: { color: ramp },
        textStyle: { color: theme.muted, fontSize: 10 },
        formatter: (val: number) => fmt(val, axisSpec(spec)),
      },
    ],
    series: [
      {
        id: "map",
        type: "map",
        map: geo,
        nameProperty: str(p.nameProperty) ?? "name",
        roam: p.roam === true && !ctx.editMode,
        left: 8,
        right: 8,
        top: 8,
        bottom: 8,
        data: [...byName.entries()].map(([name, e]) => ({ name, value: e.value, aibiRow: e.row })),
        itemStyle: { areaColor: theme.surface2, borderColor: theme.border, borderWidth: 0.8 },
        emphasis: { label: { show: true, color: theme.text }, itemStyle: { areaColor: withAlpha(theme.warning, 0.75) } },
        select: { disabled: true },
        label: { show: false },
        tooltip: { formatter: (pp: EvParams) => tipLine(pp.marker, pp.name, pp.value === undefined || Number.isNaN(pp.value) ? "No data" : fmt(pp.value, spec)) },
      },
    ],
  };
  (option.tooltip as Obj).trigger = "item";
  return { option, categories: [...byName.keys()], rowFor: rowFromData };
}
