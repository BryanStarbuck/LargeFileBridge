// Typed accessor for the app-level, computer-wide config.yaml (storage.mdx §3, settings.mdx).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppConfigSchema, type AppConfig, type FileFlags, defaultDeviceName } from "@lfb/shared";
import { readYaml, writeYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { appConfigPath } from "../../shared/store/scopes.js";
import { collectHardware } from "../storage/hardware.service.js";
import { bumpTopicThrottled, SETTINGS_TOPIC } from "../events/state-events.service.js";
import { RETIRED_GEMINI_MODELS, DEFAULT_GEMINI_MODEL } from "../describe/models.js";

// ── config.yaml read cache (mtime-keyed) ─────────────────────────────────────────────────────────────
// getAppConfig() was UNMEMOIZED, and effectiveFlags() calls it PER FILE — so GET /api/repos (repos ×
// files) and every composeFileRows build paid an fs.readFileSync + YAML.parse + full Zod safeParse per
// candidate file (thousands of parses per request). Cache the parsed+healed config keyed on the file's
// MTIME: one cheap statSync per call (config.yaml is always on fast local storage under ~/T), re-parsing
// only when the file actually changed. This is SELF-INVALIDATING — every write goes through updateYaml/
// writeYaml, which bumps the mtime, so an in-process OR external write is picked up on the next call with
// no explicit cache-busting. The whole app treats getAppConfig() as read-only (writes go through
// updateAppConfig/setFileFlags), so returning the shared cached object is safe.
let configCache: { mtimeMs: number; cfg: AppConfig } | null = null;

/** Drop the memoized config (tests / a defensive manual bust). Normal writes self-invalidate via mtime. */
export function clearAppConfigCache(): void {
  configCache = null;
}

export function getAppConfig(): AppConfig {
  const p = appConfigPath();
  // Serve the cache when the file is unchanged since we parsed it. A missing file (mtimeMs stays -1) falls
  // through to readYaml, which returns schema defaults — an uncacheable transient we simply don't cache.
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(p).mtimeMs;
  } catch {
    /* not present yet → read (seed) below; don't serve/keep a cache for a file that doesn't exist */
  }
  if (mtimeMs >= 0 && configCache && configCache.mtimeMs === mtimeMs) return configCache.cfg;

  const cfg = readYaml(p, AppConfigSchema);
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
  // Heal a Gemini model that Google has since RETIRED. A config pinned to a retired id (e.g.
  // gemini-2.0-flash) returns 404 forever, so upgrade it to the current default on load — this is what
  // makes the "Generate Description" failure self-repair without the user touching Settings
  // (ai_description.mdx §5.1). Only rewrites known-dead ids; a valid custom model is left untouched.
  if (RETIRED_GEMINI_MODELS.has(cfg.ai.gemini.model)) {
    cfg.ai.gemini.model = DEFAULT_GEMINI_MODEL;
    dirty = true;
  }
  // Heal the stale scan cadence. The old default was 4h; the policy is now "scan at least every 2h" so
  // the interest/big-file data the File System coloring relies on stays fresh (file_system.mdx §3.3).
  // Only the exact old default (4) is rewritten — a value the user deliberately chose (anything else) is
  // left untouched, mirroring the Gemini-model healing above. The installed launchd plist is re-rendered
  // to match by reconcileWorkerSchedules() at boot (main.ts).
  if (cfg.scan_process.interval_hours === 4) {
    cfg.scan_process.interval_hours = 2;
    dirty = true;
  }
  if (dirty) {
    try {
      writeYaml(p, cfg as unknown as Record<string, unknown>);
      // The write bumped the mtime — re-stat so the cache key matches the file on disk (otherwise the very
      // next call would see a newer mtime and needlessly re-parse).
      try {
        mtimeMs = fs.statSync(p).mtimeMs;
      } catch {
        mtimeMs = -1;
      }
    } catch {
      /* best-effort persist — a failure just re-seeds on the next call until a write succeeds */
    }
  }
  // Cache only when we have a real mtime to key on (the file exists). A missing/uncacheable file is re-read
  // each call — a transient that resolves as soon as the first successful write lands.
  if (mtimeMs >= 0) configCache = { mtimeMs, cfg };
  return cfg;
}

/** THIS computer's device label — the identity written into every manifest's `pinned_by` (devices.mdx §1).
 *  The single definition: pin-truth checks ("is MY label in pinned_by?" — ipfs.mdx §1.1) and the pin pass's
 *  claim writes must agree on this exact string, so neither may derive it separately. */
export function computerLabel(): string {
  return getAppConfig().computer.label || "this-computer";
}

export async function updateAppConfig(mutate: (c: AppConfig) => AppConfig): Promise<AppConfig> {
  const out = await updateYaml(appConfigPath(), AppConfigSchema, (c) => {
    if (c.scanner.roots.length === 0) c.scanner.roots = defaultRoots();
    return mutate(c);
  });
  // The one choke point every app-config write passes through (settings, flags, AI config, run stamps) —
  // open Settings pages learn live (performance.mdx Aspect 6b). Throttled: a pass may stamp in bursts.
  bumpTopicThrottled(SETTINGS_TOPIC);
  return out;
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
