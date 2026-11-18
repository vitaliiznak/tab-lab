-- Run from the directory containing daily.csv. All reads are local.
CREATE OR REPLACE TEMP VIEW readings AS
SELECT * FROM read_csv('daily.csv', header = true, columns = {
    'site_id': 'INTEGER', 'day': 'DATE', 'observed_intervals': 'INTEGER',
    'in_observations': 'INTEGER', 'out_observations': 'INTEGER',
    'bike_in': 'INTEGER', 'bike_out': 'INTEGER',
    'both_directions_zero_intervals': 'INTEGER'
});

-- Start from a calendar: an ordinary GROUP BY quietly drops the missing days.
-- Leaving the count of bikes NULL prevents inventing traffic observations.
SELECT
    cal.day::DATE AS day,
    coalesce(r.observed_intervals, 0) AS reported_of_96,
    r.bike_in + r.bike_out AS recorded_passages,
    r.both_directions_zero_intervals AS intervals_reporting_zero
FROM generate_series(DATE '2011-07-28', DATE '2011-08-09', INTERVAL 1 DAY) AS cal(day)
LEFT JOIN readings AS r ON r.day = cal.day AND r.site_id = 10
ORDER BY cal.day;

-- Could all available sites have gone quiet at once? Count coverage by site.
WITH site_coverage AS (
    SELECT sites.site_id, coalesce(sum(r.observed_intervals), 0) AS reported_intervals
    FROM (SELECT DISTINCT site_id FROM readings) AS sites
    LEFT JOIN readings AS r
      ON r.site_id = sites.site_id AND r.day BETWEEN DATE '2011-07-29' AND DATE '2011-08-08'
    GROUP BY sites.site_id
)
SELECT reported_intervals, count(*) AS sites, list(site_id ORDER BY site_id) AS site_ids
FROM site_coverage
GROUP BY reported_intervals
ORDER BY reported_intervals;
