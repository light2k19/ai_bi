### Dataset pipelines (transforms)
- Prefer doing heavy aggregation in SQL; use `pipeline` for shaping that SQL makes awkward or for HTTP sources:
  calculated ratios (`calc`), pivots for matrices, `topN` with `otherLabel`, `fillGaps` for continuous time axes,
  `periodCompare` to add `prev_`/`ly_` columns plus `_delta` and `_pct`, `join` with another dataset (`with`).
- Derived datasets: `{ "id": "joined", "from": ["actuals"], "pipeline": [{ "op": "join", "with": "budget", "on": ["dept"] }] }`.
