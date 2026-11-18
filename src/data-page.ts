import { lab, start } from "./boot";
import { prepareData, runSql } from "./data/runtime";

const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const bikeSite = el<HTMLSelectElement>("bike-site");
const station = el<HTMLSelectElement>("parquet-station");
const buildButton = el<HTMLButtonElement>("build-parquet");
const number = new Intl.NumberFormat("en-US");
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function message(id: string, text: string, error = false) {
  el(id).textContent = text;
  el(id).classList.toggle("error", error);
}

function setScene(scene: "bike" | "parquet") {
  for (const name of ["bike", "parquet"]) {
    el(`${name}-tab`).setAttribute("aria-pressed", String(scene === name));
    el(`${name}-scene`).hidden = scene !== name;
  }
}
function sceneFromHash() {
  setScene(location.hash === "#parquet" ? "parquet" : "bike");
}
el("bike-tab").onclick = () => {
  location.hash = "zurich";
};
el("parquet-tab").onclick = () => {
  location.hash = "parquet";
};
window.addEventListener("hashchange", sceneFromHash);
sceneFromHash();

// Each projection below returns only dates, controlled ASCII labels, or numbers.
function resultRows(csv: string, columns: string) {
  const [header, ...lines] = csv.trimEnd().split(/\r?\n/);
  if (header !== columns) throw Error("Unexpected DuckDB response: " + header);
  return lines.filter(Boolean).map((line) => line.split(","));
}

function nullableInteger(input: string) {
  if (input === "" || input === "NULL") return null;
  const value = Number(input);
  if (!Number.isSafeInteger(value))
    throw Error("Unexpected numeric value from DuckDB: " + input);
  return value;
}

function bikeQuery() {
  return `SELECT cal.day::DATE AS day,
       coalesce(d.observed_intervals, 0) AS quarters,
       d.bike_in + d.bike_out AS passages,
       d.both_directions_zero_intervals AS zero_quarters
FROM generate_series(DATE '2011-07-26', DATE '2011-08-11',
                     INTERVAL 1 DAY) AS cal(day)
LEFT JOIN daily AS d
  ON d.day = cal.day AND d.site_id = ${Number(bikeSite.value)}
ORDER BY cal.day;`;
}

type BikeDay = {
  day: string;
  quarters: number;
  passages: number | null;
  zeros: number | null;
};
let selectedDay = "2011-07-28";
function renderBike(days: BikeDay[]) {
  if (!days.length) throw Error("The calendar query returned no days.");
  const maximum = Math.max(1, ...days.map((d) => d.passages ?? 0));
  const upper = Math.ceil(maximum / 500) * 500;
  const ticks = el("bike-ticks");
  ticks.replaceChildren(
    ...[upper, upper / 2, 0].map((value) => {
      const span = document.createElement("span");
      span.textContent = String(value);
      return span;
    }),
  );
  const holders: HTMLButtonElement[] = [];
  function select(d: BikeDay) {
    selectedDay = d.day;
    el("selected-day").textContent = dateFormat.format(
      new Date(d.day + "T00:00:00Z"),
    );
    el("day-passages").textContent =
      d.passages === null ? "Unknown" : number.format(d.passages);
    el("day-intervals").textContent = `${d.quarters} / 96`;
    el("day-zeros").textContent =
      d.zeros === null ? "Unknown" : String(d.zeros);
    el("day-note").textContent =
      d.quarters === 0
        ? "The source contains no records for this counter on this day."
        : "A zero interval means both directions reported zero bicycle passages.";
    holders.forEach((button, index) => {
      const active = days[index].day === selectedDay;
      button.classList.toggle("selected", active);
      button.setAttribute("aria-pressed", String(active));
      button.tabIndex = active ? 0 : -1;
    });
  }
  for (const [index, d] of days.entries()) {
    const button = document.createElement("button");
    const bar = document.createElement("i");
    bar.setAttribute("aria-hidden", "true");
    button.className = "day-bar" + (d.quarters ? "" : " missing");
    const label =
      dateFormat.format(new Date(d.day + "T00:00:00Z")) +
      " · " +
      (d.passages === null
        ? "no reports"
        : number.format(d.passages) + " passages");
    button.title = label;
    button.setAttribute("aria-label", label);
    if (d.passages !== null)
      bar.style.height = `${(100 * d.passages) / upper}%`;
    button.append(bar);
    button.onclick = () => select(d);
    button.onkeydown = (event) => {
      let next = index;
      if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
      else if (event.key === "ArrowRight")
        next = Math.min(days.length - 1, index + 1);
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = days.length - 1;
      else return;
      event.preventDefault();
      select(days[next]);
      holders[next].focus();
    };
    holders.push(button);
  }
  el("bike-bars").replaceChildren(...holders);
  select(days.find((d) => d.day === selectedDay) ?? days[0]);
}

function makeParquet(path: string, order: string) {
  return `COPY (
  SELECT i::INTEGER AS minute,
         (i % 100)::SMALLINT AS station,
         (300 + (i * 17) % 1000)::SMALLINT AS watts
  FROM range(1000000) AS r(i)
  ORDER BY ${order}
) TO '/tmp/${path}.parquet'
  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 16384);`;
}
const buildSql = `SET threads = 1;\n\n${makeParquet("mixed-data", "(i * 5953) % 1000000")}\n\n${makeParquet("ordered-data", "station, minute")}`;
function parquetQuery() {
  const id = Number(station.value);
  return `WITH groups AS (
  SELECT file_name, row_group_id,
         ${id} BETWEEN stats_min_value::INT AND stats_max_value::INT AS candidate
  FROM parquet_metadata(['/tmp/mixed-data.parquet', '/tmp/ordered-data.parquet'])
  WHERE path_in_schema = 'station'
), answers AS (
  SELECT filename, count(*) AS readings, sum(watts) AS total_watts
  FROM read_parquet(['/tmp/mixed-data.parquet', '/tmp/ordered-data.parquet'], filename = true)
  WHERE station = ${id}
  GROUP BY filename
)
SELECT CASE WHEN g.file_name = '/tmp/mixed-data.parquet' THEN 'interleaved'
            ELSE 'sorted' END AS layout,
       g.row_group_id AS group_id, g.candidate::INT AS candidate,
       a.readings, a.total_watts
FROM groups AS g JOIN answers AS a ON g.file_name = a.filename
ORDER BY layout, group_id;`;
}
function showParquetSql() {
  el("parquet-sql").textContent = buildSql + "\n\n" + parquetQuery();
}
function renderGroups(rows: string[][]) {
  const samples = rows.map((r) => `${r[3]},${r[4]}`);
  if (!samples.length || new Set(samples).size !== 1)
    throw Error("The two files returned different station totals.");
  const groups = el("parquet-groups");
  const fragment = document.createDocumentFragment();
  for (const layout of ["interleaved", "sorted"]) {
    const entries = rows.filter((row) => row[0] === layout);
    if (!entries.length)
      throw Error("Missing Parquet metadata for " + layout + ".");
    const candidateCount = entries.filter((row) => row[2] === "1").length;
    const section = document.createElement("div");
    const label = document.createElement("div");
    label.className = "group-label";
    label.textContent =
      layout === "sorted" ? "Sorted by station" : "Interleaved stations";
    const count = document.createElement("span");
    count.textContent = `${candidateCount} / ${entries.length} possible`;
    label.append(count);
    const cells = document.createElement("div");
    cells.className = "group-cells";
    cells.setAttribute("aria-hidden", "true");
    for (const [, id, candidate] of entries) {
      const cell = document.createElement("i");
      cell.className = "group-cell" + (candidate === "1" ? " candidate" : "");
      cell.title = `Group ${id} · ${candidate === "1" ? "could contain station" : "ruled out"}`;
      cells.append(cell);
    }
    section.append(label, cells);
    fragment.append(section);
  }
  groups.replaceChildren(fragment);
  el("parquet-count").textContent = number.format(Number(rows[0][3]));
  el("parquet-watts").textContent = number.format(Number(rows[0][4]));
  el("parquet-site").textContent = station.value;
  el("parquet-note").textContent =
    "Both files returned the same answer. The squares show what the metadata can exclude before a scan.";
}
const customSql = el<HTMLTextAreaElement>("custom-sql");
const customRun = el<HTMLButtonElement>("run-sql");
const customResult = el("custom-result");
let builtFiles = false;
let busy = false;
function updateControls() {
  bikeSite.disabled = busy || !lab.ready;
  station.disabled = busy || !lab.ready;
  buildButton.disabled = busy || !lab.ready;
  customRun.disabled = busy || !lab.ready || !customSql.value.trim();
}
async function execute(status: string, action: () => Promise<void>) {
  if (!lab.ready || busy) return;
  busy = true;
  updateControls();
  try {
    await action();
    message(status, "");
  } catch (err) {
    message(status, err instanceof Error ? err.message : String(err), true);
  } finally {
    busy = false;
    updateControls();
  }
}
function loadBike() {
  return execute("bike-status", async () => {
    const sql = bikeQuery();
    el("bike-sql").textContent = sql;
    message("bike-status", `Reading site ${bikeSite.value} in DuckDB…`);
    const rows = resultRows(
      await runSql(sql),
      "day,quarters,passages,zero_quarters",
    );
    renderBike(
      rows.map(([day, quarters, passages, zeros]) => ({
        day,
        quarters: Number(quarters),
        passages: nullableInteger(passages),
        zeros: nullableInteger(zeros),
      })),
    );
  });
}
function loadParquet() {
  return execute("parquet-status", async () => {
    showParquetSql();
    if (!builtFiles) {
      message(
        "parquet-status",
        "Writing two million-row Parquet files in Linux…",
      );
      await runSql(buildSql);
      builtFiles = true;
    }
    message(
      "parquet-status",
      "Checking row-group statistics and querying both files…",
    );
    const rows = resultRows(
      await runSql(parquetQuery()),
      "layout,group_id,candidate,readings,total_watts",
    );
    renderGroups(rows);
    buildButton.textContent = "Compare again";
  });
}
customSql.oninput = updateControls;
customRun.onclick = () =>
  void execute("custom-status", async () => {
    const sql = customSql.value.trim();
    if (!sql) return;
    customResult.hidden = true;
    customResult.textContent = "";
    message("custom-status", "Running SQL in Linux…");
    const csv = (await runSql(sql)).trimEnd();
    const limit = 16000;
    const output =
      csv.length > limit
        ? csv.slice(0, limit) + "\n… Display truncated at 16,000 characters."
        : csv || "Statement completed with no output.";
    customResult.textContent = output;
    customResult.hidden = false;
  });
customSql.onkeydown = (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    customRun.click();
  }
};
bikeSite.onchange = () => void loadBike();
station.onchange = () => {
  showParquetSql();
  el("parquet-site").textContent = station.value;
  if (builtFiles) void loadParquet();
};
buildButton.onclick = () => void loadParquet();
el("bike-sql").textContent = bikeQuery();
showParquetSql();
function showBootStatus() {
  const status = el("status").textContent ?? "Preparing Linux…";
  el("chart-boot").textContent = status;
  message("parquet-status", status);
}
const bootStatus = new MutationObserver(showBootStatus);
bootStatus.observe(el("status"), {
  childList: true,
  characterData: true,
  subtree: true,
});
showBootStatus();
void start(prepareData).then(async () => {
  bootStatus.disconnect();
  message("parquet-status", "");
  if (lab.ready) await loadBike();
  else {
    el("chart-boot").textContent =
      "The guest did not start. See the terminal below.";
    message("bike-status", "Reload to retry the guest boot.", true);
    message("parquet-status", "Reload to retry the guest boot.", true);
  }
});
