.bail on
.timer on
SET threads = 1;
.print Generating one million synthetic meter readings as Parquet
COPY (
    SELECT i::INTEGER AS sample,
           (i % 100)::SMALLINT AS station,
           (300 + (i * 17) % 1000)::SMALLINT AS watts
    FROM range(1000000) r(i)
) TO '/tmp/meters.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);

CREATE VIEW readings AS SELECT * FROM read_parquet('/tmp/meters.parquet');
CREATE VIEW top_stations AS
    SELECT station, count(*) AS readings, sum(watts) AS total_watts
    FROM readings
    WHERE watts >= 1100
    GROUP BY station
    ORDER BY total_watts DESC, station
    LIMIT 3;

.print Top three stations by sum of high-load readings
SELECT * FROM top_stations;
.print Repeated query in the same process
SELECT * FROM top_stations;
SELECT count(*) AS total_rows FROM readings;
