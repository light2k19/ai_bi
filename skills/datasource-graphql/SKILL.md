### GraphQL data sources (kind: other)

A GraphQL data source sends one GraphQL document to the endpoint configured by the admin. Request shape:

```json
{
  "query": "query($from: String) { orders(filter: { createdAfter: $from }, first: 500) { id total status customer { name } } }",
  "variables": { "from": "{{filters.date.start}}" },
  "resultPath": "$.data.orders"
}
```

- `query` (required): **only queries** (`query … { … }` or the `{ … }` shorthand; fragments allowed). Mutations and
  subscriptions are rejected. **Select only the fields you need.**
- `variables` (optional): pass filter values through variables, never by pasting them into the query text.
  Declare each one in the operation (`query($from: String, $region: [String!])`) with the argument type shown in
  the schema. Bindings resolve to plain strings, numbers or arrays.
- `resultPath` (optional): JSONPath to the list of records, normally `$.data.<rootField>`; for a connection type use
  e.g. `$.data.orders.edges[*].node` or `$.data.orders.nodes`. When omitted and the query has one root field, that
  field is used. Nested objects become dotted columns (`customer.name`); lists inside a record become JSON text.
- `operationName` (optional): needed only when the document contains several operations.
- No `method`, `path` or `url`: the endpoint is fixed.

Schema: "Describe for AI" lists every root `Query` field as an endpoint (`path` = field name) with its arguments
(type, input-object shape, default) and the return type's fields; object types are listed as tables with their
scalar fields as columns. Use exactly those field and argument names and types.

Filtering, sorting and limits happen through the field's arguments (for example `filter`, `where`, `orderBy`,
`first`/`limit`); check the argument list for each field. Dates are usually ISO strings (`YYYY-MM-DD` or full
ISO-8601) unless the schema says otherwise. Pagination is not automatic: request one page large enough
(`first: 500`) and the platform caps rows. GraphQL usually cannot aggregate; group, sum and sort in the dataset
`pipeline` (`aggregate`, `calc`, `sort`).

Complete example (countries API: `countries(filter: CountryFilterInput)`, filter by a page filter value):

```json
{
  "query": "query($continent: String) { countries(filter: { continent: { eq: $continent } }) { code name capital currency continent { name } } }",
  "variables": { "continent": "{{filters.continent}}" },
  "resultPath": "$.data.countries"
}
```

Returns columns `code`, `name`, `capital`, `currency`, `continent.name`. GraphQL `errors[]` are reported as query
errors with the server's message; fix the field or argument it names.
