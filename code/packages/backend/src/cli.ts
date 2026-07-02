// `lfb` CLI — operate the store without the web app (scan/sync/install). tsx entry.
import { scanAll } from "./modules/scanner/scanner.service.js";
import { syncAll } from "./modules/sync/sync.service.js";
import { control } from "./modules/schedule/schedule.service.js";
import { log } from "./shared/logging.js";

async function run(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  switch (cmd) {
    case "scan":
      await scanAll("manual");
      break;
    case "sync":
      await syncAll();
      break;
    case "install-agent": {
      const worker = (a as "scan" | "sync") || "sync";
      await control(worker, "install");
      await control(worker, "enable");
      break;
    }
    case "uninstall-agent":
      await control((a as "scan" | "sync") || "sync", "uninstall");
      break;
    default:
      process.stdout.write(
        "lfb <scan|sync|install-agent [scan|sync]|uninstall-agent [scan|sync]>\n",
      );
  }
  void b;
}

run().catch((e) => {
  log.error("cli", (e as Error).message);
  process.exit(1);
});
