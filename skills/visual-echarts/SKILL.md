### Charts (echarts.*)
- Pick the chart by the question: comparison → bar (horizontal for rankings/long labels); trend → line/area;
  composition → stacked bar, pie/donut (≤ 7 slices), treemap; relationship → scatter; distribution → boxplot/heatmap;
  flow → sankey/funnel; progress to target → gauge or combo (bars + target line); variance bridge → waterfall.
- Wide data (one column per measure): set `series`. Long data (one row per x × group): set one `series` column and `groupBy`.
- Always set `format` for money (`currency`, `compactCurrency`) and ratios (`percent`, value is a ratio 0..1).
- Use `seriesNames` for readable legend labels, `dashed` for last-year/forecast lines, `referenceLines` for targets/averages.
- Charts animate on load and on data change automatically. For custom choreography use page scripts with widget handles
  (`setOption`, `highlight`, `showTip`).
- `option` deep-merges any ECharts option; `echarts.raw` gives full control when no type fits.
