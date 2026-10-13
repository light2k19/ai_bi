### SQL Server data sources (dialect: mssql)
- Use named parameters `:name` in the SQL (the gateway converts them); never `@p` or string concatenation.
- Top-N: `SELECT TOP (10) ... ORDER BY x DESC`. Paging: `ORDER BY x OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY`. No `LIMIT`.
- ORDER BY is not allowed inside derived tables/CTEs without TOP/OFFSET; put it on the outer query.
- Buckets: `FORMAT(d, 'yyyy-MM')` (slow on big tables) or `CONVERT(char(7), d, 126)` month; `DATEPART(quarter, d)`; `YEAR(d)`.
- Date filters: `d >= :start AND d < :endExclusive`. Division: `x * 1.0 / NULLIF(y, 0)`. String concat: `CONCAT(a, b)`.
- Schema-qualify tables (`dbo.Orders`); bracket identifiers with spaces (`[Order Date]`).
