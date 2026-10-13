### HTTP API data sources (kind: http)
- request: `{ "method": "GET", "path": "/sales", "query": { "from": "{{filters.date.start}}" }, "resultPath": "$.data.items" }`.
  `path` is relative to the configured base URL; never put a full URL or credentials in it.
- `resultPath` selects the array of records in the JSON response (`$`, `$.data`, `$.data.items`, `$.results[0].rows`).
  Arrays of objects become rows; nested objects are flattened with dots (`customer.name`).
- Use the documented endpoints from `introspect_schema`; call `preview_query` to see the real shape before building widgets.
- Shape the data with dataset `pipeline` transforms (aggregate, calc, sort) when the API cannot.
