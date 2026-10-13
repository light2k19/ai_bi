### Text, narrative and layout (text, narrative, image, embed, tabs)
- `text` renders Markdown (headings, lists, bold, tables) with bindings evaluated live: `{{ row.revenue | currency }}`,
  `{{ data.kpis.rows[0].margin | percent }}`, `{{ filters.date.start | date }}`. Keep binding expressions simple.
- `narrative` asks the runtime AI to write commentary from datasets each time filters change. Give a precise prompt and a word limit.
- `tabs` widgets hold child widgets in `tabs[].widgets` with their own grids (x/y/w/h inside the tab).
- `image` src may be `asset:<name>` for files in the page bundle assets.
