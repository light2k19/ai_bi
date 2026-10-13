### SQLite data sources (dialect: sqlite)
- Dates are stored as ISO text ('YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'); compare them as strings: `sold_at >= :start AND sold_at < :end`.
- Month bucket: `strftime('%Y-%m', sold_at)`; quarter: `strftime('%Y', d) || '-Q' || ((CAST(strftime('%m', d) AS INTEGER)+2)/3)`; year: `strftime('%Y', d)`.
- No RIGHT/FULL JOIN on old versions; use LEFT JOIN. Window functions (LAG, SUM() OVER) are supported.
- Use `LIMIT n` for top-N. Use `COALESCE`, `CASE WHEN`, `ROUND(x, 2)`; integer division truncates, so multiply by 1.0.
