import {
  assetUrl,
  lab,
  report,
  setActionPty,
  start,
  writeTerminal,
} from "./boot";
import { prepareRust } from "./rust";
void start(async () => ({
  ...(await prepareRust({
    assetUrl,
    report,
    writeTerminal,
    setActionPty,
    hasGpu: () => lab.gpu,
  })),
  cwd: "/",
}));
