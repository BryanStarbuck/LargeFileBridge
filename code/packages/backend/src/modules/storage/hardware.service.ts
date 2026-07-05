// The hardware fingerprint collector (devices.mdx §7, knowledge/device_identification.md). Identifies the
// PHYSICAL machine so the app can auto-name it and disambiguate similar computers. Collected ENTIRELY
// LOCALLY — os/fs always, plus best-effort macOS `sysctl` / `system_profiler` behind a short timeout. It
// must NEVER touch the network. Cached in-process; call getHardware() everywhere.
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { DeviceHardwareDoc } from "@lfb/shared";
import { lookupModel, kindFromIdentifier } from "./hardware-models.js";
import { log } from "../../shared/logging.js";

let cached: DeviceHardwareDoc | null = null;

/** Run a local tool with a hard timeout; return its stdout, or "" on any failure (missing, slow, error). */
function tryExec(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 2500, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return ""; // tool absent / timed out / non-darwin — degrade gracefully
  }
}

/** Pull "Label: value" out of a `system_profiler` block (first match wins). */
function spField(block: string, label: string): string {
  const m = block.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : "";
}

/** Total size of the root volume in GB (whole-GB), via statfs — no subprocess. */
function diskTotalGb(): number | null {
  try {
    // fs.statfsSync exists on Node 18.15+. blocks * bsize = bytes.
    const st = (fs as unknown as { statfsSync?: (p: string) => { blocks: number; bsize: number } }).statfsSync?.("/");
    if (!st) return null;
    return Math.round((st.blocks * st.bsize) / 1e9);
  } catch {
    return null;
  }
}

/** Collect the fingerprint from scratch (uncached). Safe on any platform. */
export function collectHardware(): DeviceHardwareDoc {
  const platform = os.platform();
  const userInfo = (() => {
    try {
      return os.userInfo();
    } catch {
      return { username: "" } as os.UserInfo<string>;
    }
  })();

  const hw: DeviceHardwareDoc = {
    platform,
    kind: "",
    hostname: os.hostname() || "",
    username: userInfo.username || "",
    home_dir: os.homedir() || "",
    model_identifier: "",
    model_name: "",
    marketing_name: "",
    year: null,
    chip: "",
    arch: os.arch() || "",
    cpu_cores: os.cpus()?.length ?? null,
    ram_gb: os.totalmem() ? Math.round(os.totalmem() / 1e9) : null,
    disk_total_gb: diskTotalGb(),
    screen_inches: null,
    screen_count: null,
  };

  if (platform === "darwin") {
    hw.model_identifier = tryExec("sysctl", ["-n", "hw.model"]);

    const spHw = tryExec("system_profiler", ["SPHardwareDataType"]);
    if (spHw) {
      hw.model_name = spField(spHw, "Model Name");
      // Apple silicon reports "Chip"; Intel reports "Processor Name".
      hw.chip = spField(spHw, "Chip") || spField(spHw, "Processor Name");
      if (!hw.model_identifier) hw.model_identifier = spField(spHw, "Model Identifier");
    }

    const spDisp = tryExec("system_profiler", ["SPDisplaysDataType"]);
    if (spDisp) {
      const count = (spDisp.match(/^\s*Resolution:/gm) || []).length;
      hw.screen_count = count || null;
    }

    // Resolve marketing name / year / built-in screen size / kind from the model table.
    const facts = hw.model_identifier ? lookupModel(hw.model_identifier) : null;
    if (facts) {
      hw.marketing_name = facts.marketingName;
      hw.year = facts.year;
      hw.screen_inches = facts.screenInches;
      hw.kind = facts.kind;
    } else if (hw.model_identifier) {
      hw.kind = kindFromIdentifier(hw.model_identifier) || "";
    }
    if (!hw.model_name && hw.marketing_name) hw.model_name = hw.marketing_name.replace(/\s*\(.*$/, "").trim();
  }

  // Fall back for kind when the model table couldn't decide.
  if (!hw.kind) {
    if (platform === "linux" && (hw.screen_count == null || hw.screen_count === 0)) hw.kind = "server";
    else if (platform === "darwin") hw.kind = "desktop";
    else hw.kind = "";
  }

  log.info(
    "storage",
    `hardware: ${hw.marketing_name || hw.model_name || hw.model_identifier || platform} (${hw.kind || "?"}) user=${hw.username}`,
  );
  return hw;
}

/** The cached fingerprint for this process (collected once). */
export function getHardware(): DeviceHardwareDoc {
  if (!cached) cached = collectHardware();
  return cached;
}
