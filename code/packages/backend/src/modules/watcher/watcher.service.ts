// The live filesystem watcher (scan.mdx §2.2). Event-driven, NOT a scheduleTask: it runs only while the
// web-app process is up. It subscribes to the OS's native file-change notifications over the scanner
// roots — FSEvents on macOS (primary), inotify on Linux, ReadDirectoryChangesW on Windows.
//
// Contract (scan.mdx §2.2):
//   * React to files being ADDED or DELETED — NEVER to a content "modified"/"change". A file being
//     re-saved does not change whether it is our payload, so reacting to every write is needless churn.
//     Node reports add/delete/rename as eventType "rename"; content edits as "change" (ignored).
//   * WATCH ONLY WHAT WE WOULD SCAN. Any HARD_SKIP directory (node_modules, .git, dist, …), any macOS
//     bundle, and anything matching `scanner.ignore_globs` is out — and on the platforms where a
//     recursive watch costs one kernel watch per directory it is pruned BEFORE binding, not filtered
//     after the event arrives (watch-tree.ts explains why that distinction is the whole bug).
//   * A change is QUALIFYING only when the path is a video/image/audio file (isMediaFile) OR an added
//     file at/over the big threshold. Non-media, non-big noise is dropped.
//   * Metadata-only: at most one `stat` on an added path; never open file contents; no IPFS, no network.
//   * Debounce bursts, then on each qualifying add/delete invalidate exactly what that path could have
//     made stale — the parent's cached listing and the interest tint of every directory above it — so the
//     File System tree and its folder colouring are correct within the debounce window. It does NOT kick a
//     discovery scan any more; see `flushPending` for the measurement that removed it (database.mdx §8.1).
import fs from "node:fs";
import path from "node:path";
import type { WatcherState } from "@lfb/shared";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { isDatabaseWorkingFile, isMediaFile, isTransientDownloadFile } from "../../shared/scan-filters.js";
import { invalidateFsCachesForPath } from "../fsindex/fsindex.service.js";
import { log } from "../../shared/logging.js";
import { expandHome } from "../../shared/home-path.js";
import { isDirAt } from "../../shared/fs-probe.js";
import { makeWatchFilter, watchTreePruned, type WatchFilter } from "./watch-tree.js";
import { isOwnRecentWrite } from "./self-writes.js";

// Does the OS make "recursive" cost one watch per TREE, or one per DIRECTORY? macOS (FSEvents) and
// Windows (ReadDirectoryChangesW) do it in the kernel — a single handle covers the whole subtree, and
// binding per-directory there would be strictly worse (thousands of FSEvent streams for nothing).
// Everywhere else — Linux above all, where Node emulates recursion by binding EVERY directory it walks —
// we bind the tree ourselves so the skipped subtrees cost nothing (watch-tree.ts).
const NATIVE_RECURSIVE = new Set(["darwin", "win32"]);
const prunedMode = (): boolean => !NATIVE_RECURSIVE.has(process.platform);

interface WatchRoot {
  root: string;
  close: () => void;
  /** Directories individually bound. 0 in native mode, where one handle covers the whole subtree. */
  dirs: () => number;
  truncated: () => boolean;
}

let watches: WatchRoot[] = [];
let pending = new Set<string>(); // absolute paths seen since the last flush
let debounceTimer: NodeJS.Timeout | null = null;
let debounceMs = 1500;
let generation = 0; // bumped per start, so a bind walk overtaken by a restart stays quiet

/** A snapshot of the watcher for transparency/UI (mirrors the scheduleTask transparency contract §7). */
export function watcherState(): WatcherState {
  return {
    enabled: getAppConfig().watcher.enabled,
    watching: watches.length > 0,
    roots: watches.map((w) => w.root),
    pending: pending.size,
    mode: prunedMode() ? "pruned" : "native",
    watchedDirs: watches.reduce((n, w) => n + w.dirs(), 0),
    truncated: watches.some((w) => w.truncated()),
  };
}

/**
 * Turn the live watcher on or off from the web app (the Scans-page card). Persists `watcher.enabled`
 * and reconciles the runtime: startWatcher() re-reads config and binds when enabled, or no-ops after a
 * clean stop when disabled. Unlike the scheduleTasks there is no install step — a watcher exists only
 * while this process runs, so "enabled" is the only switch (scan.mdx §2.2 / §5).
 */
export async function setWatcherEnabled(enabled: boolean): Promise<WatcherState> {
  await updateAppConfig((c) => ((c.watcher.enabled = enabled), c));
  await startWatcher();
  return watcherState();
}

/**
 * Start the live watcher over scanner.roots. Idempotent — a second call re-reads config and rebinds.
 * No-op when `watcher.enabled` is false. Called once from main() after the server binds.
 *
 * Resolves once every root is bound. In pruned mode that means the initial tree walk has finished; the
 * root's own watch is live from the first step, so events are never missed while it runs.
 */
export async function startWatcher(): Promise<void> {
  // Claim the generation BEFORE anything else, so an in-flight bind walk is disowned even when this call
  // is the one that turns the watcher OFF — otherwise that walk would return and log "started over 0
  // root(s)" after the user had just disabled it.
  const gen = ++generation;
  stopWatcher(); // rebind cleanly if already running
  const cfg = getAppConfig();
  if (!cfg.watcher.enabled) {
    log.info("watcher", "Live filesystem watcher is disabled (watcher.enabled=false) — not started.");
    return;
  }
  debounceMs = cfg.watcher.debounce_ms;
  const roots = cfg.scanner.roots.map(expandHome).filter(isDirAt);
  const pruned = prunedMode();

  const bound: Promise<void>[] = [];
  for (const root of roots) {
    const filter = makeWatchFilter(root, cfg.scanner.ignore_globs);
    if (pruned) bound.push(bindPruned(root, filter, cfg.watcher.max_watched_dirs));
    else bindNative(root, filter);
  }
  await Promise.all(bound);
  if (gen !== generation) return; // a restart overtook this bind — the newer run owns the log line

  const dirs = watches.reduce((n, w) => n + w.dirs(), 0);
  log.info(
    "watcher",
    `Live filesystem watcher started over ${watches.length} root(s)` +
      (pruned ? ` / ${dirs} folder(s), skipping node_modules/.git/build and your scan ignore list` : "") +
      "; reacting to add/delete of big + media files.",
  );
}

/** One root on Linux/other: our own pruned per-directory watch set (watch-tree.ts). */
async function bindPruned(root: string, filter: WatchFilter, maxDirs: number): Promise<void> {
  const w = watchTreePruned(root, {
    maxDirs,
    shouldWatch: filter.dirOk,
    onChange: (abs) => onChange(abs, filter),
    onWarn: (message) => log.warn("watcher", message),
  });
  watches.push({ root, close: () => w.close(), dirs: () => w.size(), truncated: () => w.truncated() });
  await w.ready;
}

/** One root on macOS/Windows: a single native recursive handle, filtered as events arrive. */
function bindNative(root: string, filter: WatchFilter): void {
  try {
    const w = fs.watch(root, { recursive: true }, (eventType, filename) => {
      if (eventType !== "rename") return; // "change" == modified content — deliberately ignored (§2.2)
      if (filename == null) return; // no path → nothing actionable
      onChange(path.join(root, filename.toString()), filter);
    });
    w.on("error", (e) => log.warn("watcher", `watch error on ${root}: ${(e as Error).message}`));
    watches.push({ root, close: () => w.close(), dirs: () => 0, truncated: () => false });
  } catch (e) {
    // A root that can't be watched (permissions, too many watches) must never crash boot — the
    // 4-hour scheduled scan still covers it. Warn and carry on with the other roots.
    log.warn("watcher", `could not watch ${root}: ${(e as Error).message}`);
  }
}

/** Stop and release all OS watches. Called on shutdown (SIGINT/SIGTERM) and before a rebind. */
export function stopWatcher(): void {
  for (const w of watches) w.close();
  watches = [];
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pending.clear();
}

/**
 * One add/delete/move, already narrowed to "rename" by the binding above. Cheap, synchronous filtering
 * here — never wake on VCS/deps/build churn or on `scanner.ignore_globs` (§2.2) — and the real work is
 * debounced into flushPending(). In pruned mode those directories were never bound in the first place;
 * the same predicate still runs so both platforms honour one contract.
 */
function onChange(abs: string, filter: WatchFilter): void {
  if (!filter.pathOk(abs)) return;
  pending.add(abs);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPending, debounceMs);
}

/**
 * A burst has settled. For every qualifying add/delete, forget the cached filesystem answers that path
 * could have invalidated — its parent listing and the interest tint of every directory above it — and
 * nothing else.
 *
 * WHY THIS IS NO LONGER `startScan("manual")` (the slice-12 change; database.mdx §8.1).
 *
 * It used to be. One qualifying add/delete escalated to a FULL DISCOVERY WALK of every registered repo,
 * and that is the write amplification underneath the "pages are spinning" complaint. The escalation was
 * nearly six orders of magnitude larger than the thing it was reacting to:
 *
 *   * one dropped video ⇒ a scan across 105 registered repos, measured from this app's own `[scan]` log
 *     lines at 40.9-66.9 s, median 53.9 s over the last 12 runs — against 0.068 ms for the invalidation
 *     below, and 0.6 ms for a 200-file burst;
 *   * `loop-watch` recorded that scan blocking the event loop for 3,299 ms across one 30 s window (worst
 *     single call 440 ms), while `["scanStatus"]` was named in live "PAGE STILL SPINNING" reports;
 *   * what had actually gone stale was 0-6 in-memory Map entries (the number `dropped` reports below);
 *   * and `startScan` coalesces but does not cancel — a folder of files dropped one per second kept a
 *     rerun permanently queued, so the scan bar never came down and every page polling scan-status stayed
 *     in its loading state. That is the same shape as the two incidents already recorded in
 *     `isQualifying` (the yt-dlp fragment, the Badger working file); this is the third and the largest.
 *
 * WHAT WE GIVE UP, said plainly: `status.yaml` tracking, the candidate lists and the TO DO rollups are no
 * longer refreshed within seconds of a file landing. They are refreshed by the scheduled 4-hour discovery
 * scan and by `maybeTriggerStaleScan` on page load (scan-job.ts), which is the reconciliation path the
 * product already relies on for every non-media change and for every machine whose watcher is off. The
 * File System browser — the surface a user is actually looking at when they drop a file into a folder —
 * is correct IMMEDIATELY, which it was not before: the stale tint above the parent directory survived the
 * old rescan too, because the rescan never touched these caches.
 *
 * If a future product decision wants the scan back on this path, it belongs behind a rate limiter and a
 * "the tree changed a lot" threshold, not on every qualifying file.
 */
function flushPending(): void {
  debounceTimer = null;
  const batch = pending;
  pending = new Set<string>();
  const threshold = getAppConfig().big_file.threshold_bytes;

  let qualifying: string | null = null;
  let count = 0;
  let dropped = 0;
  for (const abs of batch) {
    if (!isQualifying(abs, threshold)) continue;
    qualifying ??= abs;
    count += 1;
    // Per PATH, not once for the burst: two files landing in unrelated trees invalidate two chains, and
    // collapsing them onto the first path's chain would leave the second tree's tints stale until its TTL.
    dropped += invalidateFsCachesForPath(abs);
  }
  if (!qualifying) return;

  log.info(
    "watcher",
    `Detected add/delete of ${count} big/media file(s) (e.g. ${qualifying}) — refreshed the File System ` +
      `browser's folder colouring for the affected folders (${dropped} cached answer(s) dropped). ` +
      `Large File Bridge will pick up tracking changes on its next scan.`,
  );
}

/**
 * Is this add/delete worth a rescan? Qualifying = a video/image/audio file (by extension), OR an ADDED
 * file at/over the big threshold. On a delete the file is gone, so size can't be read — the media
 * extension test carries the delete case; a deleted big NON-media file is reconciled by the 4-hour scan.
 * Metadata-only: a single `stat`, never a content read (scan.mdx §1/§2.2).
 */
function isQualifying(abs: string, threshold: number): boolean {
  const name = path.basename(abs);
  // A file WE just wrote is not news (self-writes.ts). The pin pass places pulled-down media into the
  // working tree, and every landing file looked exactly like a user dropping a video in — so a six-file
  // pull kicked six discovery rescans, each walking every repo and recalculating the TO DO batches, all
  // while the remaining transfers were still competing for the same disk. The pass already knows about
  // these files; the walk would only rediscover what put them there.
  if (isOwnRecentWrite(abs)) return false;
  // A downloader's in-flight temp file churns add/delete every few seconds while a download runs. Waking
  // on it kicks a rescan at exactly the moment the fragment exists, which is how a vanished yt-dlp
  // fragment became a permanent row (scan.mdx §4.3.1). The final merged file's own appearance still
  // qualifies, so the rescan that matters is never lost. Our OWN IPFS fetch temp is in this set too —
  // waking on it means every file the pin process pulls down queues a rescan of the whole tree.
  if (isTransientDownloadFile(name)) return false;
  // A running embedded database (Badger/LevelDB/SQLite) churns big working files every few seconds; each
  // one queued another full rescan, keeping the scan bar up forever (scan.mdx §2.2 / 2026-08-04).
  if (isDatabaseWorkingFile(name)) return false;
  if (isMediaFile(name)) return true; // video/image/audio — add or delete both matter
  try {
    const st = fs.statSync(abs); // present → this is an add/appear; size decides
    return st.isFile() && st.size >= threshold;
  } catch {
    // Not statable → a delete of a non-media path we can't size; not qualifying on its own.
    return false;
  }
}
