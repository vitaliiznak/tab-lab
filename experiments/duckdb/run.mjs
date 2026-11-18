import { readFile } from "node:fs/promises";
import { loadDuckdbInputs } from "./assets.mjs";
import { createKernel, fetchDistro, MemoryFs } from "unkernel/node";

const args = new Set(process.argv.slice(2));
const interactive = args.delete("--shell");
const selected = args.delete("--zurich")
  ? "zurich"
  : args.delete("--pruning")
    ? "pruning"
    : "meters";
if (args.size || (interactive && !process.stdin.isTTY))
  throw Error(
    "Usage: node experiments/duckdb/run.mjs [--zurich | --pruning] [--shell (TTY)]",
  );

const cases = {
  meters: { sql: "meters.sql", inputs: [], cwd: "/opt/lab" },
  pruning: { sql: "pruning.sql", inputs: [], cwd: "/opt/lab" },
  zurich: {
    sql: "zurich/case.sql",
    inputs: ["zurich/daily.csv"],
    cwd: "/opt/lab/zurich",
  },
};
const experiment = cases[selected];

const [{ binary, packages }, distro] = await Promise.all([
  loadDuckdbInputs(),
  fetchDistro("alpine"),
]);
const files = new MemoryFs();
files.writeFile("/duckdb", binary, { mode: 0o555 });
for (const { name, data } of packages)
  files.writeFile("/" + name, data, { mode: 0o444 });
for (const file of [experiment.sql, ...experiment.inputs]) {
  files.writeFile(
    "/" + file,
    await readFile(new URL("./" + file, import.meta.url)),
    { mode: 0o444 },
  );
}

const vm = await createKernel({
  worker: true,
  cpus: 1,
  memoryMiB: 384,
  distro,
  mounts: { "/opt/lab": { fs: files, readOnly: true } },
});
try {
  async function run(file, args) {
    const result = await vm.exec(file, args, {
      user: "root",
      cwd: experiment.cwd,
    });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0)
      throw Error(file + " exited " + result.exitCode + "\n" + result.stdout);
    return result.stdout;
  }
  await run("apk", [
    "--no-network",
    "--repositories-file",
    "/dev/null",
    "add",
    ...packages.map((x) => "/opt/lab/" + x.name),
  ]);
  const cli = "/opt/lab/duckdb";
  process.stdout.write(await run(cli, ["-version"]));
  const database = "/tmp/lab.duckdb";
  const output = await run(cli, [
    "-no-init",
    "-batch",
    "-csv",
    database,
    ".read /opt/lab/" + experiment.sql,
  ]);
  process.stdout.write(output);
  if (
    selected === "zurich" &&
    (![
      "2011-07-28,96,568,15",
      "2011-08-09,96,1381,13",
      "0,1,[10]",
      "288,1,[6]",
      '1056,9,"[5, 7, 8, 9, 12, 13, 52, 53, 54]"',
    ].every((row) => output.includes(row)) ||
      (output.match(/^2011-[\d-]+,0,NULL,NULL\r?$/gm) || []).length !== 11)
  )
    throw Error("Unexpected Zürich coverage result");
  if (
    selected === "pruning" &&
    ![
      "interleaved,62,62",
      "sorted,62,2",
      "interleaved,10000,8490000",
      "sorted,10000,8490000",
    ].every((s) => output.includes(s))
  )
    throw Error("Unexpected pruning result");
  if (
    selected === "meters" &&
    ((output.match(/^47,2000,2498000\r?$/gm) || []).length !== 2 ||
      !/^1000000\r?$/m.test(output))
  )
    throw Error("Unexpected query result");

  if (interactive) {
    console.log("Use .tables to inspect the case, or .quit to exit.");
    const pty = await vm.spawn(cli, ["-no-init", database], {
      user: "root",
      cwd: experiment.cwd,
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });
    const send = (chunk) => void pty.write(chunk).catch(() => {});
    const resize = () =>
      pty.resize(process.stdout.columns || 80, process.stdout.rows || 24);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.on("data", send);
    process.stdout.on("resize", resize);
    try {
      await Promise.all([
        pty.ended,
        (async () => {
          for await (const chunk of pty.output) process.stdout.write(chunk);
        })(),
      ]);
    } finally {
      process.stdin.off("data", send);
      process.stdout.off("resize", resize);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
    }
  }
} finally {
  await vm.stop();
}
