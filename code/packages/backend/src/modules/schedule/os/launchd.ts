// macOS launchd installer (scan.mdx §3.1). Renders a plist LaunchAgent and drives launchctl.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SchedulerInstaller, InstallOpts } from "./installer.js";
import { log } from "../../../shared/logging.js";

const run = promisify(execFile);

function agentPath(label: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function renderPlist(o: InstallOpts): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${o.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${o.nodeBin}</string>
    <string>${o.triggerScript}</string>
    <string>${o.worker}</string>
    <string>${o.apiPort}</string>
  </array>
  <key>StartInterval</key><integer>${o.intervalSeconds}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${o.logOut}</string>
  <key>StandardErrorPath</key><string>${o.logErr}</string>
</dict>
</plist>
`;
}

async function launchctl(...args: string[]): Promise<void> {
  try {
    await run("launchctl", args);
  } catch (e) {
    log.warn("schedule", `launchctl ${args.join(" ")}: ${(e as Error).message}`);
  }
}

function domainTarget(label: string): string {
  return `gui/${process.getuid?.() ?? 501}/${label}`;
}

export const launchdInstaller: SchedulerInstaller = {
  async install(o) {
    const file = agentPath(o.label);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderPlist(o));
    log.info("schedule", `Installed launchd plist ${file}`);
  },
  async uninstall(label) {
    await this.disable(label);
    try {
      fs.unlinkSync(agentPath(label));
    } catch {
      /* already gone */
    }
  },
  async enable(label) {
    await launchctl("bootstrap", `gui/${process.getuid?.() ?? 501}`, agentPath(label));
    await launchctl("enable", domainTarget(label));
  },
  async disable(label) {
    await launchctl("bootout", domainTarget(label));
  },
  isInstalled(label) {
    try {
      return fs.existsSync(agentPath(label));
    } catch {
      return false;
    }
  },
  async isEnabled(label) {
    try {
      await run("launchctl", ["print", domainTarget(label)]);
      return true;
    } catch {
      return false;
    }
  },
};
