### KPI tiles (kpi, kpiRow)
- Feed KPIs from a dataset that returns one row of totals (best) or many rows plus `aggregate`.
- `compare` shows the delta vs another column (e.g. `ly_revenue` from the same SQL using `{{filters.date.lyStart}}`/`lyEndExclusive`), coloured green/red (`invert: true` when lower is better).
- `target` shows progress to a target column or number. `sparkline` plots a column over the dataset rows (use a monthly dataset).
- Tiles count up from zero on load by default; page scripts can call `handle.countUp()` / `handle.flash()`.
