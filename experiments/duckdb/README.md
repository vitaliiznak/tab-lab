# DuckDB inside Tab Lab

Run from the repository root with Node 24, `unzip` on the host and dependencies installed via `npm ci`.

```sh
node --experimental-wasm-jspi experiments/duckdb/run.mjs
```

Choose an experiment:

| Arguments    | What you can verify                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--zurich`   | Investigate an 11-day gap in real City of Zürich bicycle-counter observations. Compare missing intervals with recorded zeros and see which other sites kept reporting. [Data and provenance](zurich/README.md) |
| `--pruning`  | Two layouts of identical sensor rows produce the same SQL answer. Parquet statistics rule out 60 of 62 groups in the sorted file and none in the interleaved file. [Query](pruning.sql)                        |
| No arguments | Generate one million synthetic readings, write Zstd Parquet and run two top-three aggregations. [Query](meters.sql)                                                                                            |

Add `--shell` to any case for an interactive guest DuckDB prompt. Enter `.tables` to inspect the database or `.quit` to leave. In the default case, try `SELECT station, max(watts) FROM readings GROUP BY station ORDER BY station LIMIT 10;`.

The host downloads the pinned Alpine guest and the official [DuckDB 1.5.6 ARM64 musl CLI](https://github.com/duckdb/duckdb/releases/tag/v1.5.6). Two small signed Alpine runtime APKs are included in `packages/`. The runner checks SHA-256 for both packages, the CLI archive and the extracted binary. It caches the CLI archive under `$XDG_CACHE_HOME/tab-lab/duckdb/1.5.6` (default `~/.cache`). `TAB_LAB_CACHE_DIR` overrides the cache root. The pinned unkernel SDK manages the Alpine base in its own cache.

The 384 MiB, single-CPU guest receives a read-only host mount, installs the two local signed packages, and runs with networking disabled. The default meter query reads a Parquet file written moments before, so it is a warm-file-cache measurement. The database and Parquet file disappear on exit. Times come from DuckDB in the Node-hosted Linux guest. The [browser data lab](https://vitaliiznak.github.io/tab-lab/data/) runs the Zürich and Parquet cases with the same native CLI inside its own Linux guest.
