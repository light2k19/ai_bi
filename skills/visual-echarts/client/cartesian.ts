import {
  areaGradient,
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
import { axisSpec, detectXFormat, humanize, keyOf, objArr, str, strArr, strMap, toNum, withAlpha, type Obj, type Row } from "./util";

type Kind = "bar" | "line" | "area" | "combo";

interface SeriesDef {
  id: string;
  /** column (wide) or group value (long) */
  key: string;
  name: string;
  kind: "bar" | "line";
  spec: string | undefined;
  values: (number | null)[];
  rows: (Row | undefined)[];
  secondary: boolean;
  dashed: boolean;
}

export function buildCartesian(ctx: BuildCtx, kind: Kind): Built {
  const { props: p, frame, rows, theme, fmt } = ctx;
  const x = hasColumn(frame, str(p.x)) ? str(p.x)! : firstCategoryCol(frame);
  if (!x) return { option: {}, message: "Set `x` to a category column." };
  const groupBy = kind !== "combo" && hasColumn(frame, str(p.groupBy)) ? str(p.groupBy) : undefined;
  const names = strMap(p.seriesNames);
  const secondarySet = new Set(strArr(p.secondary));
  const dashedSet = new Set(strArr(p.dashed));
  const horizontal = kind === "bar" && p.horizontal === true;

  // ── which columns are bars / lines ──
  let cols: { col: string; kind: "bar" | "line" }[];
  if (kind === "combo") {
    let bars = strArr(p.bars);
    let lines = strArr(p.lines);
    if (!bars.length && !lines.length) {
      const nums = numericCols(frame, [x]);
      bars = nums.slice(0, 1);
      lines = nums.slice(1);
    }
    cols = [...bars.map((col) => ({ col, kind: "bar" as const })), ...lines.map((col) => ({ col, kind: "line" as const }))];
  } else {
    const s = strArr(p.series);
    const list = s.length ? s : numericCols(frame, [x, groupBy]);
    cols = (groupBy ? list.slice(0, 1) : list).map((col) => ({ col, kind: kind === "bar" ? ("bar" as const) : ("line" as const) }));
  }
  if (!cols.length) return { option: {}, message: "No numeric columns to plot — set `series`." };

  // ── categories and series values ──
  let categories: unknown[] = [];
  let defs: SeriesDef[] = [];
  if (groupBy) {
    const measure = cols[0].col;
    const catIndex = new Map<string, number>();
    const groups = new Map<string, { label: unknown; values: (number | null)[]; rows: (Row | undefined)[] }>();
    for (const r of rows) {
      const ck = keyOf(r[x]);
      if (!catIndex.has(ck)) {
        catIndex.set(ck, categories.length);
        categories.push(r[x]);
      }
    }
    for (const r of rows) {
      const gk = keyOf(r[groupBy]);
      let g = groups.get(gk);
      if (!g) {
        g = { label: r[groupBy], values: categories.map(() => null), rows: categories.map(() => undefined) };
        groups.set(gk, g);
      }
      const i = catIndex.get(keyOf(r[x]))!;
      const v = toNum(r[measure]);
      if (v !== null) g.values[i] = (g.values[i] ?? 0) + v;
      g.rows[i] ??= r;
    }
    defs = [...groups.entries()].map(([gk, g]) => ({
      id: `g:${gk}`,
      key: gk,
      name: names[gk] ?? (gk === "" ? "(blank)" : gk),
      kind: cols[0].kind,
      spec: ctx.fmtFor(measure),
      values: g.values,
      rows: g.rows,
      secondary: secondarySet.has(gk),
      dashed: dashedSet.has(gk),
    }));
  } else {
    categories = rows.map((r) => r[x]);
    defs = cols.map(({ col, kind: k }) => ({
      id: `c:${col}`,
      key: col,
      name: names[col] ?? humanize(col),
      kind: k,
      spec: ctx.fmtFor(col),
      values: rows.map((r) => toNum(r[col])),
      rows: rows.slice(),
      secondary: secondarySet.has(col),
      dashed: dashedSet.has(col),
    }));
  }

  // ── sort categories ──
  const sort = str(p.sort);
  if (sort === "asc" || sort === "desc") {
    const primary = defs.filter((d) => !d.secondary);
    const totals = categories.map((_, i) => primary.reduce((s, d) => s + (d.values[i] ?? 0), 0));
    const order = categories.map((_, i) => i).sort((a, b) => (sort === "asc" ? totals[a] - totals[b] : totals[b] - totals[a]));
    categories = order.map((i) => categories[i]);
    for (const d of defs) {
      d.values = order.map((i) => d.values[i]);
      d.rows = order.map((i) => d.rows[i]);
    }
  }

  // ── 100% stack ──
  const percentStack = p.percentStack === true;
  if (percentStack) {
    const primary = defs.filter((d) => !d.secondary);
    const totals = categories.map((_, i) => primary.reduce((s, d) => s + Math.abs(d.values[i] ?? 0), 0));
    for (const d of primary) d.values = d.values.map((v, i) => (v === null || totals[i] === 0 ? null : v / totals[i]));
  }

  const stacked = kind === "area" ? p.stack !== false && defs.length > 1 : p.stack === true || percentStack;
  const xFormat = str(p.xFormat) ?? detectXFormat(categories);
  const labels = categories.map((c) => (xFormat ? fmt(c, xFormat) : keyOf(c)));
  const primarySpec = percentStack ? "percent" : defs.find((d) => !d.secondary)?.spec;
  const secondaryDefs = defs.filter((d) => d.secondary);
  const secondarySpec = str(p.secondaryFormat) ?? secondaryDefs[0]?.spec;
  const showLabels = p.labels === true;
  const nPoints = categories.length;
  const showSymbols = p.symbols === true ? true : p.symbols === false ? false : nPoints <= 16;
  const colors = ctx.colors;

  const series: Obj[] = defs.map((d, i) => {
    const color = colors[i % colors.length];
    // a series on the secondary axis is formatted like that axis (e.g. a rate next to counts), not like the bars
    const spec = d.secondary ? (secondarySpec ?? d.spec) : percentStack ? "percent:1" : d.spec;
    const s: Obj = {
      id: d.id,
      name: d.name,
      type: d.kind,
      data: d.values,
      tooltip: { valueFormatter: (v: unknown) => (v === null || v === undefined || v === "-" ? "–" : fmt(v, spec)) },
    };
    if (d.secondary) s[horizontal ? "xAxisIndex" : "yAxisIndex"] = 1;
    const inStack = stacked && !d.secondary && (kind !== "combo" || d.kind === "bar");
    if (inStack) s.stack = "total";
    if (d.kind === "bar") {
      const r = inStack ? 2 : 4;
      s.barMaxWidth = 44;
      s.barCategoryGap = defs.length > 1 ? "28%" : "36%";
      s.itemStyle = { borderRadius: horizontal ? [0, r, r, 0] : [r, r, 0, 0] };
      s.emphasis = { itemStyle: { shadowBlur: 14, shadowColor: withAlpha(theme.text, 0.3), borderColor: theme.text, borderWidth: 1 } };
      if (p.colorBy === "data") s.colorBy = "data";
    } else {
      const area = kind === "area" || p.area === true;
      s.smooth = p.smooth === true;
      s.showSymbol = showSymbols;
      s.symbol = "circle";
      s.symbolSize = 6;
      s.lineStyle = { width: d.dashed ? 2 : 2.5, type: d.dashed ? "dashed" : "solid" };
      s.emphasis = { focus: "series", lineStyle: { width: 3 } };
      if (kind === "combo") s.z = 3;
      if (area && !d.dashed) s.areaStyle = stacked ? { color: withAlpha(color, 0.35) } : { color: areaGradient(color, theme.mode === "dark" ? 0.38 : 0.28, 0.02) };
      if (d.dashed) s.itemStyle = { opacity: 0.85 };
    }
    if (showLabels) {
      const ls = d.secondary ? secondarySpec : percentStack ? "percent:0" : axisSpec(spec);
      s.label = haloLabel(theme, {
        show: true,
        position: inStack && d.kind === "bar" ? "inside" : horizontal ? "right" : "top",
        formatter: (pp: EvParams) => (pp.value === null || pp.value === undefined ? "" : fmt(pp.value, ls)),
      });
    }
    return s;
  });

  // ── reference lines on the first primary series ──
  const refs = objArr(p.referenceLines);
  if (refs.length) {
    const target = series[defs.findIndex((d) => !d.secondary)] ?? series[0];
    const data: Obj[] = [];
    for (const r of refs) {
      const t = str(r.type) ?? "value";
      const color = str(r.color) ?? theme.muted;
      const label = str(r.label);
      const line: Obj = {
        name: label,
        lineStyle: { color, type: "dashed", width: 1.5 },
        label: {
          color,
          fontSize: 11,
          position: "insideEndTop",
          formatter: (pp: EvParams) => `${label ? `${label}  ` : ""}${fmt(pp.value, axisSpec(primarySpec))}`,
        },
      };
      if (t === "average" || t === "min" || t === "max") line.type = t;
      else {
        let v = toNum(r.value);
        if (v === null && typeof r.value === "string" && hasColumn(frame, r.value)) v = toNum(rows[0]?.[r.value]);
        if (v === null) continue;
        line[horizontal ? "xAxis" : "yAxis"] = v;
      }
      data.push(line);
    }
    if (data.length) target.markLine = { silent: true, symbol: "none", data, animationDuration: 600 };
  }

  // ── axes ──
  const valueAxes: Obj[] = [
    valueAxis(theme, fmt, primarySpec, { id: "v0", ...(percentStack ? { max: 1 } : {}) }),
  ];
  if (secondaryDefs.length) valueAxes.push(valueAxis(theme, fmt, secondarySpec, { id: "v1", splitLine: { show: false } }));
  const catAxis = categoryAxis(theme, labels, {
    id: "cat",
    boundaryGap: kind === "bar" || kind === "combo",
    ...(horizontal
      ? { inverse: true, axisLabel: { color: theme.muted, fontSize: 11, width: Math.max(64, Math.round(ctx.width * 0.28)), overflow: "truncate" } }
      : {}),
  });

  const lp = legendPos(p.legend, defs.length > 1 ? "top" : false);
  const zoom = p.dataZoom === true;
  const grid: Obj = {
    left: 8,
    // lines start/end on the edge ticks, so leave room for half of the last x label
    right: (lp === "right" ? 128 : kind === "line" || kind === "area" ? 30 : 16) + (horizontal && showLabels ? 36 : 0) + (horizontal && zoom ? 24 : 0),
    top: (lp === "top" ? 36 : 14) + (horizontal && secondaryDefs.length ? 18 : 0),
    bottom: (lp === "bottom" ? 30 : 4) + (zoom && !horizontal ? 34 : 0),
    containLabel: true,
  };

  const option: Obj = {
    ...baseOption(theme, colors),
    grid,
    legend: legendOption(theme, lp),
    xAxis: horizontal ? valueAxes : catAxis,
    yAxis: horizontal ? catAxis : valueAxes,
    series,
    dataZoom: zoom ? sliderZoom(theme, horizontal, ctx.editMode) : [],
  };
  (option.tooltip as Obj).trigger = "axis";
  (option.tooltip as Obj).axisPointer = {
    ...((option.tooltip as Obj).axisPointer as Obj),
    type: kind === "bar" || kind === "combo" ? "shadow" : "line",
  };

  return {
    option,
    categories: categories.map(keyOf),
    seriesKeys: defs.map((d) => d.key),
    rowFor: (pp) => (pp.seriesIndex !== undefined ? defs[pp.seriesIndex]?.rows[pp.dataIndex] : undefined),
  };
}
