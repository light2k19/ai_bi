### Filters
- Page filters sit in a bar above the widgets; datasets reference them through bindings in `request.params` (SQL) or `request.query` (HTTP).
- Date ranges: `{{filters.date.start}}`, `{{filters.date.endExclusive}}`; last year: `{{filters.date.lyStart}}`, `{{filters.date.lyEndExclusive}}`; previous period: `prevStart`/`prevEndExclusive`.
- Multi-select options can come from a small dataset (`options: { dataset, value, label }`); bind `{{filters.region.values}}` and `{{filters.region.allFlag}}`.
- Widgets can set filters on click: `interactions: [{ "on": "click", "action": "setFilter", "filter": "region", "value": "{{ [row.region] }}" }]`.
