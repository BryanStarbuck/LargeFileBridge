// Typed accessor for the app-level, computer-wide config.yaml (storage.mdx §3, settings.mdx).
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppConfigSchema, type AppConfig, type FileFlags, defaultDeviceName } from "@lfb/shared";
import { readYaml, writeYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { appConfigPath } from "../../shared/store/scopes.js";
import { collectHardware } from "../storage/hardware.service.js";

export function getAppConfig(): AppConfig {
  const cfg = readYaml(appConfigPath(), AppConfigSchema);
  let dirty = false;
  // First-run seeding of sensible scanner roots so the app has something to show.
  if (cfg.scanner.roots.length === 0) {
    cfg.scanner.roots = defaultRoots();
  }
  // Mint this computer's stable device id on first use — a real UUID, DISTINCT from the IPFS PeerID
  // (which can change if the keypair is reset). It is the durable key by which this machine is known in
  // every storage's devices/ registry and in pinned_by (devices.mdx §1). Persist it so it stays stable.
  if (!cfg.computer.id || cfg.computer.id.trim() === "") {
    cfg.computer.id = randomUUID();
    dirty = true;
  }
  // Seed this machine's HARDWARE FINGERPRINT once (devices.mdx §7) — collected locally, no network. The
  // empty `platform` is the "not yet collected" signal (the schema default is a blank object).
  if (!cfg.computer.hardware.platform) {
    try {
      cfg.computer.hardware = collectHardware();
      dirty = true;
    } catch {
      /* collection is best-effort; a failure just retries on the next call */
    }
  }
  // Auto-seed a friendly device name from the fingerprint (devices.mdx §8) instead of leaving the bare
  // "this-computer" placeholder. The user can rename it any time from the web app.
  if (!cfg.computer.label || cfg.computer.label === "this-computer") {
    const hw = cfg.computer.hardware;
    const name = defaultDeviceName({
      username: hw.username,
      modelName: hw.model_name,
      hostname: hw.hostname,
    });
    if (name && name !== "this-computer") {
      cfg.computer.label = name;
      dirty = true;
    }
  }
  if (dirty) {
    try {
      writeYaml(appConfigPath(), cfg as unknown as Record<string, unknown>);
    } catch {
      /* best-effort persist — a failure just re-seeds on the next call until a write succeeds */
    }
  }
  return cfg;
}

export async function updateAppConfig(mutate: (c: AppConfig) => AppConfig): Promise<AppConfig> {
  return updateYaml(appConfigPath(), AppConfigSchema, (c) => {
    if (c.scanner.roots.length === 0) c.scanner.roots = defaultRoots();
    return mutate(c);
  });
}

function defaultRoots(): string[] {
  const home = process.env.HOME || "~";
  return [`${home}/BGit`, `${home}/Documents`];
}

// ── Sticky per-entity flags (menus.mdx §6.6, files.mdx, directories.mdx) ─────
// Stored app-scope keyed by ABSOLUTE path. A directory's flag applies to everything under it, so the
// EFFECTIVE flag for a path is its own entry OR'd with any ancestor directory's entry.

/** The exact flags stored ON this path (not inherited). Used by the entity page's own toggle state. */
export function ownFlags(absPath: string): FileFlags {
  const e = getAppConfig().file_flags[path.resolve(absPath)];
  return { neverIpfs: e?.never_ipfs ?? false, noCompress: e?.no_compress ?? false };
}

/** The effective flags for this path: its own entry OR any ancestor directory's entry (path-scoped). */
export function effectiveFlags(absPath: string): FileFlags {
  const map = getAppConfig().file_flags;
  const target = path.resolve(absPath);
  let neverIpfs = false;
  let noCompress = false;
  for (const [key, val] of Object.entries(map)) {
    const k = path.resolve(key);
    if (target === k || target.startsWith(k + path.sep)) {
      neverIpfs = neverIpfs || !!val.never_ipfs;
      noCompress = noCompress || !!val.no_compress;
    }
  }
  return { neverIpfs, noCompress };
}

/** Write one or both flags for a path; a flag that turns fully off is pruned so the map stays lean. */
export async function setFileFlags(
  absPath: string,
  patch: { neverIpfs?: boolean; noCompress?: boolean },
): Promise<FileFlags> {
  const key = path.resolve(absPath);
  await updateAppConfig((c) => {
    const cur = c.file_flags[key] ?? { never_ipfs: false, no_compress: false };
    const next = {
      never_ipfs: patch.neverIpfs ?? cur.never_ipfs,
      no_compress: patch.noCompress ?? cur.no_compress,
    };
    if (!next.never_ipfs && !next.no_compress) delete c.file_flags[key];
    else c.file_flags[key] = next;
    return c;
  });
  return ownFlags(key);
}
