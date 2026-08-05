// The hardware fingerprint collector (devices.mdx §7, knowledge/device_identification.md). Identifies the
// PHYSICAL machine so the app can auto-name it and disambiguate similar computers. Collected ENTIRELY
// LOCALLY — os/fs always, plus best-effort macOS `sysctl` / `system_profiler` behind a short timeout. It
// must NEVER touch the network. Cached in-process; call getHardware() everywhere.
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { DeviceHardwareDoc } from "@lfb/shared";
import { lookupModel, kindFromIdentifier } from "./hardware-models.js";
import { stableGitBin } from "../git/git-bin.js";
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

/**
 * The VOLATILE half of the fingerprint (devices.mdx §7.1) — the facts that legitimately change while the
 * app is installed, so they must never be frozen at first-run seeding the way the model/chip/RAM facts are:
 *
 *   • the machine's IP addresses (a laptop changes them every time it joins a network), and
 *   • the git identity (`user.name` / `user.email`) the user can reconfigure at any time.
 *
 * Both are read ENTIRELY LOCALLY — `os.networkInterfaces()` reads the kernel's own interface table and
 * `git config` reads a file on disk. No packet leaves the machine, so the §7 "never over the network"
 * rule holds.
 */
export interface VolatileHardware {
  home_user: string;
  git_user_name: string;
  git_user_email: string;
  primary_ip: string;
  ip_addresses: string[];
}

/**
 * This computer's non-loopback addresses, best LAN IPv4 first. The ORDER is the point: `primary_ip` is
 * whatever lands first, and the address the user's other computers can actually reach is a private IPv4
 * (192.168.x / 10.x / 172.16–31.x), not a link-local 169.254 or an IPv6 fe80:: scope id. So private IPv4
 * sorts first, then any other IPv4, then IPv6, and link-local sorts last within its family.
 */
function localIpAddresses(): string[] {
  let ifaces: ReturnType<typeof os.networkInterfaces>;
  try {
    ifaces = os.networkInterfaces();
  } catch {
    return [];
  }
  const rank = (a: { address: string; family: string | number }): number => {
    const v4 = a.family === "IPv4" || a.family === 4;
    const addr = a.address;
    const linkLocal = addr.startsWith("169.254.") || addr.toLowerCase().startsWith("fe80:");
    const priv = v4 && (/^192\.168\./.test(addr) || /^10\./.test(addr) || /^172\.(1[6-9]|2\d|3[01])\./.test(addr));
    if (linkLocal) return v4 ? 40 : 50;
    if (priv) return 0;
    return v4 ? 10 : 30;
  };
  const found: Array<{ address: string; r: number }> = [];
  const seen = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.internal) continue; // loopback — never an address another computer can use
      // Strip the IPv6 zone suffix (fe80::1%en0) so the stored value is a plain address.
      const address = a.address.split("%")[0];
      if (!address || seen.has(address)) continue;
      seen.add(address);
      found.push({ address, r: rank(a) });
    }
  }
  found.sort((x, y) => x.r - y.r || x.address.localeCompare(y.address));
  return found.map((f) => f.address);
}

/** `git config --get <key>`, or "" when git is absent / the key is unset. Reads local config files only. */
function gitConfig(key: string): string {
  // --global first (the user's own identity), falling back to the fully-resolved value so a machine that
  // only sets an identity per-repo or system-wide still reports one. Run from the home dir so we never
  // pick up whatever repo the process happens to be sitting in.
  const home = os.homedir() || "/";
  for (const args of [["config", "--global", "--get", key], ["config", "--get", key]]) {
    try {
      const out = execFileSync(stableGitBin(), args, {
        cwd: home,
        encoding: "utf8",
        timeout: 2500,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) return out;
    } catch {
      // git missing, key unset (exit 1), or timed out — try the next form, then give up quietly
    }
  }
  return "";
}

/** Collect the volatile fields fresh. Cheap enough to call on every device write (no system_profiler). */
export function collectVolatileHardware(): VolatileHardware {
  const home = os.homedir() || "";
  const ips = localIpAddresses();
  return {
    // The account name as it appears in the home path (/Users/bryan → "bryan"). Distinct from
    // `username` on purpose: they usually match, but the home directory is what the user recognises,
    // and on a machine with a renamed account or a relocated home they differ.
    home_user: home ? home.split("/").filter(Boolean).pop() || "" : "",
    git_user_name: gitConfig("user.name"),
    git_user_email: gitConfig("user.email"),
    primary_ip: ips[0] ?? "",
    ip_addresses: ips,
  };
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
    ...collectVolatileHardware(),
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

/**
 * The fingerprint for this process. The EXPENSIVE half (model / chip / screens — `system_profiler`) is
 * collected once and cached; the volatile half (IP addresses, git identity) is re-read on demand behind a
 * short TTL, so a laptop that moved to another network reports its new address on the next device write
 * instead of publishing the address it happened to have the day the app was installed.
 */
const VOLATILE_TTL_MS = 60_000;
let volatile: { at: number; v: VolatileHardware } | null = null;

/** The volatile fields, re-collected at most once a minute. */
export function freshVolatileHardware(): VolatileHardware {
  const now = Date.now();
  if (!volatile || now - volatile.at > VOLATILE_TTL_MS) {
    volatile = { at: now, v: collectVolatileHardware() };
  }
  return volatile.v;
}

export function getHardware(): DeviceHardwareDoc {
  if (!cached) cached = collectHardware();
  return { ...cached, ...freshVolatileHardware() };
}
