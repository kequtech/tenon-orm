WITH table_counts AS (
  SELECT relnamespace, count(*) AS total
  FROM pg_catalog.pg_class
  WHERE relkind IN ('r', 'p')
  GROUP BY relnamespace
)
SELECT n.nspname AS schema_name,
  coalesce(t.total, 0) AS table_count,
  dense_rank() OVER (ORDER BY n.nspname) AS rank,
  jsonb_build_object('schema', n.nspname, 'tables', coalesce(t.total, 0)) AS summary
FROM pg_catalog.pg_namespace n
LEFT JOIN table_counts t ON t.relnamespace = n.oid
WHERE n.nspname = $1
ORDER BY n.nspname;
