### Tables (table, pivot)
- `table` without `columns` shows every column with automatic formats; list `columns` to choose order, labels and formats.
- Use `total: "sum"` per column (or `totals: true` for all numeric), `bar: true` for magnitude, `heat: true` for performance ratios, `delta: true` for variances.
- `pivot` aggregates in the browser: rows × columns × value; prefer it for month-by-region style matrices.
- Use `conditional` on the widget for rule-based styling: `[{ "when": "row.attainment < 0.9", "column": "attainment", "style": { "color": "var(--danger)", "fontWeight": 600 } }]`.
