### PostgreSQL data sources (dialect: postgres)

- Parameters: named `:name` only, never string concatenation. Lists: `region IN (:regions)`. Dates: `sold_at >= :start AND sold_at < :endExclusive`; cast when the type is ambiguous: `CAST(:start AS date)` (do not use `::` next to a parameter).
- Buckets: `date_trunc('month', sold_at)`, `date_trunc('quarter', sold_at)`, `date_trunc('year', sold_at)`; labels: `to_char(sold_at, 'YYYY-MM')`, `EXTRACT(YEAR FROM sold_at)`.
- Top-N: `ORDER BY total DESC LIMIT 10` (or `FETCH FIRST 10 ROWS ONLY`).
- Concatenation: `a || ' ' || b` or `concat(a, b)` (`||` yields NULL if any part is NULL). Safe division: `x / NULLIF(y, 0)`; integer / integer truncates, so use `x::numeric / NULLIF(y, 0)` or `100.0 * x / NULLIF(y, 0)`.
- Identifiers: unquoted names fold to lower case; quote mixed-case names with double quotes (`"OrderId"`). Strings use single quotes; `ILIKE` is case-insensitive LIKE.
- Result column names come back lower-case unless quoted: alias with `AS total_amount`, or `AS "Total"` to keep case.
- Qualify tables with their schema (`sales.orders`) unless the table is in the default schema.
- `count(*)` and `sum()` of integers return bigint, `avg()` returns numeric; both arrive as numbers. Round with `round(x::numeric, 2)`.
- `GROUP BY` must list every non-aggregated column; you may `GROUP BY 1, 2`. Subquery in `FROM` needs an alias.
- Read-only: only one SELECT/WITH statement per query; no temp tables, no `SELECT … INTO`.
