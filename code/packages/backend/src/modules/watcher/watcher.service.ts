// The live filesystem watcher (scan.mdx §2.2). Event-driven, NOT a scheduleTask: it runs only while the
// web-app process is up. It subscribes to the OS's native file-change notifications over the scanner
// roots — FSEvents on macOS (primary), inotify on Linux, ReadDirectoryChangesW on Windows — via Node's
// `fs.watch({ recursive: true })`, which binds to each of those natively.
//
// Contract (scan.mdx §2.2):
//   * React to files being ADDED or DELETED — NEVER to a content "modified"/"change". A file being
//     re-saved does not change whether it is our payload, so reacting to every write is needless churn.
//     Node reports add/delete/rename as eventType "rename"; content edits as "change" (ignored).
//   * A change is QUALIFYING only when the path is a video/image/audio file (isMediaFile) OR an added
//     file at/over the big threshold. Non-media, non-big noise and any HARD_SKIP path are dropped.
//   * Metadata-only: at most one `stat` on an added path; never open file contents; no IPFS, no network.
//   * Debounce bursts, then on ≥1 qualifying add/delete kick the SAME single-flight, coalesced discovery
//     worker the Rescan button drives (startScan) — so status.yaml tracking, interesting-directory
//     coloring, and the File System tree refresh in seconds instead of waiting for the 4-hour scan.
import fs from "node:fs";
import path from "node:path";
import type { WatcherState } from "@lfb/shared";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { HARD_SKIP, isMediaFile } from "../../shared/scan-filters.js";
import { startScan } from "../scanner/scan-job.js";
import { log } from "../../shared/logging.js";

interface WatchRoot {
  root: string;
  watcher: fs.FSWatcher;
}

let watches: WatchRoot[] = [];
let pending = new Set<string>(); // absolute paths seen since the last flush
let debounceTimer: NodeJS.Timeout | null = null;
let debounceMs = 1500;

/** A snapshot of the watcher for transparency/UI (mirrors the scheduleTask transparency contract §7). */
export function watcherState(): WatcherState {
  return {
    enabled: getAppConfig().watcher.enabled,
    watching: watches.length > 0,
    roots: watches.map((w) => w.root),
    pending: pending.size,
  };
}

/**
 * Turn the live watcher on or off from the web app (the Scans-page card). Persists `watcher.enabled`
 * and re-syncs the runtime: startWatcher() re-reads config and binds when enabled, or no-ops after a
 * clean stop when disabled. Unlike the scheduleTasks there is no install step — a watcher exists only
 * while this process runs, so "enabled" is the only switch (scan.mdx §2.2 / §5).
 */
export async function setWatcherEnabled(enabled: boolean): Promise<WatcherState> {
  await updateAppConfig((c) => ((c.watcher.enabled = enabled), c));
  startWatcher();
  return watcherState();
}

/**
 * Start the live watcher over scanner.roots. Idempotent — a second call re-reads config and rebinds.
 * No-op when `watcher.enabled` is false. Called once from main() after the server binds.
 */
export function startWatcher(): void {
  stopWatcher(); // rebind cleanly if already running
  const cfg = getAppConfig();
  if (!cfg.watcher.enabled) {
    log.info("watcher", "Live filesystem watcher is disabled (watcher.enabled=false) — not started.");
    return;
  }
  debounceMs = cfg.watcher.debounce_ms;
  const roots = cfg.scanner.roots.map(expandHome).filter(safeIsDir);
  for (const root of roots) {
    try {
      // recursive: FSEvents (Mac) / ReadDirectoryChangesW (Windows) natively; inotify (Linux, Node ≥20).
      const w = fs.watch(root, { recursive: true }, (eventType, filename) =>
        onFsEvent(root, eventType, filename),
      );
      w.on("error", (e) => log.warn("watcher", `watch error on ${root}: ${(e as Error).message}`));
      watches.push({ root, watcher: w });
    } catch (e) {
      // A root that can't be watched (permissions, too many watches) must never crash boot — the
      // 4-hour scheduled scan still covers it. Warn and carry on with the other roots.
      log.warn("watcher", `could not watch ${root}: ${(e as Error).message}`);
    }
  }
  log.info(
    "watcher",
    `Live filesystem watcher started over ${watches.length} root(s); reacting to add/delete of big + media files.`,
  );
}

/** Stop and release all OS watches. Called on shutdown (SIGINT/SIGTERM) and before a rebind. */
export function stopWatcher(): void {
  for (const { watcher } of watches) {
    try {
      watcher.close();
    } catch {
      // Closing an already-closed/errored watch is harmless — nothing to do.
    }
  }
  watches = [];
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pending.clear();
}

/**
 * One raw OS event. `filename` is relative to the watched root (and may be null on some platforms). We
 * act ONLY on "rename" (add/delete/move) — never "change" (a content edit), per scan.mdx §2.2. Cheap,
 * synchronous filtering here; the real work is debounced into flushPending().
 */
function onFsEvent(root: string, eventType: fs.WatchEventType, filename: string | Buffer | null): void {
  if (eventType !== "rename") return; // "change" == modified content — deliberately ignored (§2.2)
  if (filename == null) return; // no path → nothing actionable
  const rel = filename.toString();
  // Never wake on VCS/deps/build churn (node_modules, .git, build, …) — the shared HARD_SKIP set (§4.3).
  if (rel.split(path.sep).some((seg) => HARD_SKIP.has(seg))) return;
  pending.add(path.join(root, rel));
  scheduleFlush();
}

function scheduleFlush(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPending, debounceMs);
}

/**
 * A burst has settled. Decide whether ANY pending path is a qualifying add/delete of a big/media file,
 * and if so kick one coalesced discovery scan. `startScan` is single-flight + coalescing, so a storm of
 * drops yields at most one in-flight walk plus one queued follow-up — never a walk per file (§2.2/§10).
 */
function flushPending(): void {
  debounceTimer = null;
  const batch = pending;
  pending = new Set<string>();
  const threshold = getAppConfig().big_file.threshold_bytes;

  let qualifying: string | null = null;
  for (const abs of batch) {
    if (isQualifying(abs, threshold)) {
      qualifying = abs;
      break;
    }
  }
  if (!qualifying) return;

  log.info(
    "watcher",
    `Detected add/delete of a big/media file (e.g. ${qualifying}) — kicking a discovery rescan.`,
  );
  startScan("manual");
}

/**
 * Is this add/delete worth a rescan? Qualifying = a video/image/audio file (by extension), OR an ADDED
 * file at/over the big threshold. On a delete the file is gone, so size can't be read — the media
 * extension test carries the delete case; a deleted big NON-media file is reconciled by the 4-hour scan.
 * Metadata-only: a single `stat`, never a content read (scan.mdx §1/§2.2).
 */
function isQualifying(abs: string, threshold: number): boolean {
  const name = path.basename(abs);
  if (isMediaFile(name)) return true; // video/image/audio — add or delete both matter
  try {
    const st = fs.statSync(abs); // present → this is an add/appear; size decides
    return st.isFile() && st.size >= threshold;
  } catch {
    // Not statable → a delete of a non-media path we can't size; not qualifying on its own.
    return false;
  }
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, process.env.HOME || "~");
}
function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
