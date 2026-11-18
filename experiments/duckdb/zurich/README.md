# Did Zürich stop cycling for eleven days?

Site 10 recorded 568 bike passages on July 28, 2011 and 1,381 on August 9. What happened in between? Open this directory and run:

```sh
duckdb :memory: < case.sql
```

The first result shows **11 days with zero reports**. All 1,056 expected quarter-hours are missing. Compare July 28, when the counter **reported zero bikes in both directions in 15 intervals** and reported counts for the other 81. The second result shows that nine other sites reported all 1,056 intervals over those eleven days. Site 6 reported 288. The file establishes a gap in observations at site 10; the amount of traffic during the gap is unknown.

To explore, change `r.site_id = 10` to `r.site_id = 6` in the first query. Compare the dates on which the two counters resume reporting.

## Data

The 5,541-byte fixture contains daily aggregates for **all 11 site IDs** from July 26 through August 11, 2011, inclusive. It was calculated from 16,032 source records, each identified by site and local quarter-hour. There are 167 observed site-days. Days without rows are absent from the CSV. The query constructs its own calendar to display them.

For each site and date, `observed_intervals` counts records. Directional totals sum the available raw detector counts, with their respective non-empty observation counts recorded separately. A directional total stays blank when there are no observations for that direction. The final field counts intervals where both directions actually reported zero. These are uncorrected counts of detected passages.

Source: Tiefbauamt der Stadt Zürich, distributed through Open Data Zürich, **CC0**. [2011 CSV](https://data.stadt-zuerich.ch/dataset/ted_taz_verkehrszaehlungen_werte_fussgaenger_velo/download/2011_verkehrszaehlungen_werte_fussgaenger_velo.csv) · [Dataset, field descriptions and licence](https://data.stadt-zuerich.ch/dataset/83ca481f-275c-417b-9598-3902c481e400).
