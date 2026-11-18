-- The two layouts hold identical rows. A candidate is a row group whose
-- station min/max includes 47. The count describes metadata, not physical I/O.
SET threads = 1;

COPY (
    SELECT i::INTEGER AS minute,
           (i % 100)::SMALLINT AS station,
           (300 + (i * 17) % 1000)::SMALLINT AS watts
    FROM range(1000000) r(i)
    ORDER BY (i * 5953) % 1000000
) TO '/tmp/interleaved.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 16384);

SELECT 'interleaved' AS layout, count(*) AS total,
       count_if(stats_min_value::INT <= 47 AND stats_max_value::INT >= 47) AS candidates
FROM parquet_metadata('/tmp/interleaved.parquet')
WHERE path_in_schema = 'station';

SELECT 'interleaved' AS layout, count(*) AS readings, sum(watts) AS total_watts
FROM read_parquet('/tmp/interleaved.parquet')
WHERE station = 47;

COPY (
    SELECT i::INTEGER AS minute,
           (i % 100)::SMALLINT AS station,
           (300 + (i * 17) % 1000)::SMALLINT AS watts
    FROM range(1000000) r(i)
    ORDER BY station, minute
) TO '/tmp/sorted.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 16384);

SELECT 'sorted' AS layout, count(*) AS total,
       count_if(stats_min_value::INT <= 47 AND stats_max_value::INT >= 47) AS candidates
FROM parquet_metadata('/tmp/sorted.parquet')
WHERE path_in_schema = 'station';

SELECT 'sorted' AS layout, count(*) AS readings, sum(watts) AS total_watts
FROM read_parquet('/tmp/sorted.parquet')
WHERE station = 47;
