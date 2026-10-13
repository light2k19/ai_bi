### MySQL data sources (dialect: mysql)
- Date filters: `col >= :start AND col < :endExclusive` (bind `{{filters.date.start}}` / `{{filters.date.endExclusive}}`) so indexes are used; avoid wrapping indexed columns in functions in WHERE.
- Buckets: `DATE_FORMAT(d, '%Y-%m')` month, `CONCAT(YEAR(d), '-Q', QUARTER(d))` quarter, `YEAR(d)`.
- Top-N: `ORDER BY x DESC LIMIT 10`. Window functions need MySQL 8 / MariaDB 10.2+.
- Multi-select filters: `(:all = 1 OR region IN (:regions))` with params `all: "{{filters.region.allFlag}}"`, `regions: "{{filters.region.values}}"`.
- Quote identifiers with backticks only when needed. Division: `x / NULLIF(y, 0)`.
