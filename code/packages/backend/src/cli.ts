// `lfb` CLI — operate the store without the web app (scan/pin/install). tsx entry.
import { scanAll } from "./modules/scanner/scanner.service.js";
import { pinAll } from "./modules/pin/pin.service.js";
import { control } from "./modules/schedule/schedule.service.js";
import { log } from "./shared/logging.js";

async function run(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  switch (cmd) {
    case "scan":
      await scanAll("manual");
      break;
    case "pin":
      await pinAll();
      break;
    case "install-agent": {
      const worker = (a as "scan" | "pin") || "pin";
      await control(worker, "install");
      await control(worker, "enable");
      break;
    }
    case "uninstall-agent":
      await control((a as "scan" | "pin") || "pin", "uninstall");
      break;
    default:
      process.stdout.write(
        "lfb <scan|pin|install-agent [scan|pin]|uninstall-agent [scan|pin]>\n",
      );
  }
  void b;
}

run().catch((e) => {
  log.error("cli", (e as Error).message);
  process.exit(1);
});
