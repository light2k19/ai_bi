### Oracle data sources (dialect: oracle)
- Result column names come back lower-cased (unquoted Oracle identifiers are upper-case; the connector lowers them). Use simple aliases: `SUM(amount) AS revenue`.
- Dates: bind ISO strings and convert explicitly: `sold_at >= TO_DATE(:start, 'YYYY-MM-DD') AND sold_at < TO_DATE(:endExclusive, 'YYYY-MM-DD')`.
- Buckets: `TO_CHAR(d, 'YYYY-MM')` month, `TO_CHAR(d, 'YYYY') || '-Q' || TO_CHAR(d, 'Q')` quarter, `EXTRACT(YEAR FROM d)`.
- Top-N: `ORDER BY x DESC FETCH FIRST 10 ROWS ONLY` (12c+). No `LIMIT`, no `TOP`. Single-row selects need `FROM dual`.
- Do not end the query with a semicolon. Division: `x / NULLIF(y, 0)`. Schema-qualify tables (`SALES.ORDERS`).
