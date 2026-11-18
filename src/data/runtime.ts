import { MemoryFs, type KernelHandle } from "unkernel/web";
import { assetUrl, report, type LabSetup } from "../boot";
import dailyCsv from "../../experiments/duckdb/zurich/daily.csv?raw";

const directory = "/opt/lab";
const cli = directory + "/duckdb";
const database = "/tmp/data.duckdb";
const packages = ["libgcc-15.2.0-r5.apk", "libstdc++-15.2.0-r5.apk"];
let machine: KernelHandle | undefined;
let pending = Promise.resolve();

async function execute(vm: KernelHandle, sql: string) {
  const result = await vm.exec(
    cli,
    [
      "-no-init",
      "-batch",
      "-bail",
      "-csv",
      "-header",
      "-nullvalue",
      "",
      database,
    ],
    {
      user: "root",
      cwd: directory,
      input: sql + "\n",
    },
  );
  if (result.exitCode !== 0)
    throw Error(result.stderr.trim() || "DuckDB query failed");
  return result.stdout;
}

export function runSql(sql: string): Promise<string> {
  const vm = machine;
  if (!vm) return Promise.reject(Error("The data lab is still starting."));
  // Each CLI process writes the same session database. Serialize editor and chart work.
  const result = pending.then(() => execute(vm, sql));
  pending = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function loadAsset(name: string, decompress = false) {
  const response = await fetch(assetUrl("data-runtime/" + name));
  if (!response.ok || !response.body)
    throw Error(`Could not load ${name} (HTTP ${response.status})`);
  const bytes = decompress
    ? await new Response(
        response.body.pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer()
    : await response.arrayBuffer();
  return new Uint8Array(bytes);
}

export async function prepareData(): Promise<LabSetup> {
  report("Loading DuckDB 1.5.6…");
  const [binary, ...libraries] = await Promise.all([
    loadAsset("duckdb-1.5.6.bin", true),
    ...packages.map((name) => loadAsset(name)),
  ]);
  const files = new MemoryFs();
  files.writeFile("/duckdb", binary, { mode: 0o555 });
  files.writeFile("/daily.csv", dailyCsv, { mode: 0o444 });
  packages.forEach((name, index) =>
    files.writeFile("/" + name, libraries[index], { mode: 0o444 }),
  );
  return {
    options: {
      distro: {
        kind: "http",
        url: assetUrl("images/base.disk"),
        prefetch: false,
      },
      memoryMiB: 384,
      memoryFallbackMiB: [],
      mounts: { [directory]: { fs: files, readOnly: true } },
    },
    cwd: directory,
    env: { PATH: `${directory}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` },
    async connect(vm) {
      report("Installing DuckDB’s runtime libraries…");
      const result = await vm.exec(
        "apk",
        [
          "--no-network",
          "--repositories-file",
          "/dev/null",
          "add",
          ...packages.map((name) => `${directory}/${name}`),
        ],
        { user: "root" },
      );
      if (result.exitCode !== 0)
        throw Error(
          result.stderr.trim() || "Could not install DuckDB’s libraries",
        );
      await execute(
        vm,
        `CREATE VIEW daily AS SELECT * FROM read_csv_auto('${directory}/daily.csv');`,
      );
      machine = vm;
      void vm.exited.then(() => {
        if (machine === vm) machine = undefined;
      });
    },
  };
}
