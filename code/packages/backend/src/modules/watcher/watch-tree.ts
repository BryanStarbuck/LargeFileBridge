// What the live watcher is ALLOWED to bind a kernel watch to, and a pruned recursive watcher for the
// platforms where "recursive" costs one watch per DIRECTORY (scan.mdx §2.2).
//
// WHY THIS EXISTS. `fs.watch(dir, { recursive: true })` means very different things per platform:
//   * macOS   — one FSEvents stream covers the whole subtree. O(1) kernel objects.
//   * Windows — one ReadDirectoryChangesW handle covers the whole subtree. O(1) kernel objects.
//   * Linux   — inotify has NO recursive mode, so Node emulates it: it walks the tree and binds an
//     inotify watch to EVERY directory it finds, plus every directory that later appears.
// On Linux that means `node_modules`, `.git/objects/**`, `dist/`, `.venv/` — trees whose events we throw
// away the instant they arrive — each holding a real kernel watch. Filtering AFTER the event arrives
// (watcher.service's HARD_SKIP test) saves the rescan but never the watch.
//
// Over one 188-repo scanner root that was 104,188 directories. Watches are capped per USER
// (`fs.inotify.max_user_watches`) and shared with every other program on the machine, so the watcher hit
// `ENOSPC: System limit for number of file watchers reached` and from then on silently stopped seeing
// the adds/deletes it exists to catch (observed 2026-08-04). Pruning first takes the same root to ~30k.
//
// So: prune BEFORE binding. Walk the tree ourselves, skip any directory `shouldWatch` rejects, and bind
// one NON-recursive watch per surviving directory — a skipped subtree then costs exactly zero.
import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { HARD_SKIP, isMacPackageDir } from "../../shared/scan-filters.js";
import { lstatOrNull } from "../../shared/fs-probe.js";
import { relPosix } from "../../shared/rel-path.js";

const YIELD_EVERY = 500; // hand the event loop back every N directories bound — boot must not block
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
const IGNORE_PROBE_RESET = 200_000; // rebuild the glob matcher this often — its path cache never evicts

// ── What may be watched ─────────────────────────────────────────────────────

export interface WatchFilter {
  /** May we bind a watch to this directory and descend into it? */
  dirOk: (abs: string, name: string) => boolean;
  /** Is this changed path one the watcher may even consider waking for? */
  pathOk: (abs: string) => boolean;
}

/**
 * Build the watcher's prune/ignore predicate for one scanner root.
 *
 * It is the SCANNER's own prune set — `HARD_SKIP` plus macOS bundles, exactly what `walkUnit()` in
 * scanner.service.ts refuses to descend into — plus the user's `scanner.ignore_globs`, which scan.mdx
 * §2.2 says apply "before either test". Watching what the scan would never index is pure cost: the
 * events are dropped on arrival, and on Linux each of those directories holds a kernel watch we cannot
 * spare (see the file header).
 *
 * `ignore` speaks gitignore, so paths are made root-relative and POSIX-separated first.
 */
export function makeWatchFilter(root: string, globs: string[]): WatchFilter {
  const active = globs.length > 0;
  let ig = ignore().add(globs);
  let probes = 0;
  // `ignore` memoizes EVERY path it is asked about — plus each of that path's parents — in a cache it
  // never evicts. The scanner gets away with that because its instance dies with the walk; ours lives as
  // long as the process, and is asked about every event path for weeks. Rebuilding from the same handful
  // of globs costs microseconds, so drop the cache on a schedule instead of growing it forever.
  const ignores = (p: string): boolean => {
    if (!active) return false;
    if ((probes += 1) > IGNORE_PROBE_RESET) {
      ig = ignore().add(globs);
      probes = 0;
    }
    return ig.ignores(p);
  };
  // Can an ignored directory be PRUNED whole? Only when no pattern is a NEGATION — a `!keep/big.mp4`
  // re-includes something under an otherwise-ignored tree, and pruning the tree would stop watching it.
  // Same reasoning, same three probes as `dirIsExcluded` in scanner.service.ts: the gitignore grammar
  // spells "this whole directory" as `foo`, `foo/`, or `foo/**`, and `ignores()` is literal about each.
  const hasNegation = globs.some((g) => g.trimStart().startsWith("!"));
  const rel = (abs: string): string => relPosix(root, abs);
  const outsideRoot = (r: string): boolean => r === "" || r === ".." || r.startsWith("../");
  const dirIgnored = (r: string): boolean =>
    ignores(r) || ignores(`${r}/`) || (!hasNegation && ignores(`${r}/.lfb-prune-probe`));

  return {
    dirOk: (abs, name) => {
      if (HARD_SKIP.has(name) || isMacPackageDir(name)) return false;
      const r = rel(abs);
      return !outsideRoot(r) && !dirIgnored(r);
    },
    pathOk: (abs) => {
      const r = rel(abs);
      if (outsideRoot(r)) return false;
      const segs = r.split("/");
      // Every segment but the last is a directory we would never have walked into.
      if (segs.some((s) => HARD_SKIP.has(s))) return false;
      if (segs.slice(0, -1).some((s) => isMacPackageDir(s))) return false;
      return !ignores(r);
    },
  };
}

// ── The pruned recursive watcher ────────────────────────────────────────────

export interface PrunedWatchOpts {
  /** False = never bind or descend into this directory. Given its absolute path and its basename. */
  shouldWatch: (abs: string, name: string) => boolean;
  /**
   * A file at `abs` was added, deleted or moved. Content edits ("change") never reach this. Also fired
   * for each file carried in by a directory that was moved/created under the root, which the kernel
   * reports as one event for the directory alone.
   */
  onChange: (abs: string) => void;
  /** Non-fatal trouble, already phrased for the log. */
  onWarn: (message: string) => void;
  /** Ceiling on kernel watches for this root. Reaching it refuses further binds — announced, never
   *  silent — but does not latch: watches handed back by a deleted tree are usable again. */
  maxDirs: number;
}

export interface PrunedWatch {
  readonly root: string;
  /** Resolves when the initial tree walk has bound every surviving directory. */
  readonly ready: Promise<void>;
  /** Directories currently bound. */
  size(): number;
  /** True once binding stopped early — the cap was reached or the kernel refused another watch. */
  truncated(): boolean;
  close(): void;
}

class PrunedTreeWatch implements PrunedWatch {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private closed = false;
  // The OS itself refused a watch (ENOSPC). Every further bind fails identically until the user raises
  // the sysctl, so this one IS sticky — retrying per directory would only reprint the same failure.
  private refused = false;
  private cut = false; // binding stopped short of the whole tree: cap reached, or the OS refused
  private capWarned = false;
  readonly ready: Promise<void>;

  constructor(
    readonly root: string,
    private readonly opts: PrunedWatchOpts,
  ) {
    this.ready = this.bindTree(root);
  }

  size(): number {
    return this.watchers.size;
  }

  truncated(): boolean {
    return this.cut;
  }

  close(): void {
    this.closed = true; // also stops an in-flight bindTree walk on its next step
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {
        // Closing an already-closed/errored watch is harmless — nothing to release.
      }
    }
    this.watchers.clear();
  }

  /**
   * Walk `from` and bind every surviving directory. Iterative and yielding: one root can hold tens of
   * thousands of directories and this runs during boot, so it must never hold the event loop (the same
   * rule the scan walk follows — scan.mdx §10).
   *
   * `announceFiles` reports the files found on the way as changes. FALSE for the initial walk — those
   * files are not news, the scan already knows them. TRUE for a subtree that just APPEARED, because a
   * directory renamed into the root (`mv ~/Downloads/shoot ~/Media/`) is one single event: the kernel
   * never reports the files inside it, so without this a folder of videos dropped into a scanner root
   * would sit unnoticed until the 4-hour pass. It also closes the gap between `mkdir` and this walk
   * binding the new directory, during which a file written into it produces no event of its own.
   */
  private async bindTree(from: string, announceFiles = false): Promise<void> {
    const stack = [from];
    let sinceYield = 0;
    while (stack.length && !this.closed && !this.refused) {
      const dir = stack.pop()!;
      if (!this.bind(dir)) continue; // already bound (its subtree is covered) or unbindable
      if ((sinceYield += 1) >= YIELD_EVERY) {
        sinceYield = 0;
        await yieldToLoop();
      }
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable subdir — its own watch still stands; routine, not worth a warning
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) {
          // Symlinks are neither followed nor reported — the scan walk skips them too
          // (scanner.service.ts `walkUnit`), so a link is never payload on either side.
          if (announceFiles && ent.isFile()) this.opts.onChange(path.join(dir, ent.name));
          continue;
        }
        // isDirectory() is false for a symlink, so symlinked directories are never followed — no cycle
        // risk, and the scan walk refuses them the same way.
        const abs = path.join(dir, ent.name);
        if (this.opts.shouldWatch(abs, ent.name)) stack.push(abs);
      }
    }
  }

  /** Bind one directory. True when a NEW watch was placed — i.e. the caller should descend into it. */
  private bind(dir: string): boolean {
    if (this.closed || this.refused || this.watchers.has(dir)) return false;
    if (this.watchers.size >= this.opts.maxDirs) {
      // The cap is a CEILING, not a latch: deleting a big tree hands its watches back, and the next
      // folder to appear should be watched again rather than waiting for a restart. So refuse this one
      // and say it ONCE — a walk whose binds all fail here drains its stack without another readdir.
      this.cut = true;
      if (!this.capWarned) {
        this.capWarned = true;
        this.opts.onWarn(
          `hit the ${this.opts.maxDirs}-folder live-watch limit under ${this.root} — folders past it are not ` +
            `watched live (the scheduled discovery pass still covers them). Raise watcher.max_watched_dirs to widen it.`,
        );
      }
      return false;
    }
    try {
      const w = fs.watch(dir, { recursive: false }, (eventType, filename) =>
        this.onRaw(dir, eventType, filename),
      );
      w.on("error", (e) => this.release(dir, e as Error));
      this.watchers.set(dir, w);
      return true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOSPC") {
        // The OS is out of watches for this user, so every further bind fails identically. Stop asking
        // and say it ONCE, with the knob that fixes it — not a warning per directory.
        this.refused = true;
        this.cut = true;
        this.opts.onWarn(
          `the OS refused another file watch (ENOSPC) after ${this.watchers.size} folders under ${this.root}. ` +
            `Live watching is partial from here; the scheduled discovery pass still covers the rest. On Linux, ` +
            `raise /proc/sys/fs/inotify/max_user_watches (sudo sysctl fs.inotify.max_user_watches=524288).`,
        );
      } else {
        this.opts.onWarn(`could not watch ${dir}: ${err.message}`);
      }
      return false;
    }
  }

  private release(dir: string, err?: Error): void {
    const w = this.watchers.get(dir);
    if (!w) return;
    try {
      w.close();
    } catch {
      // Already closed — nothing to release.
    }
    this.watchers.delete(dir);
    if (err) this.opts.onWarn(`stopped watching ${dir}: ${err.message}`);
  }

  /** Release `dir` and everything under it — that subtree is gone (deleted or moved away). */
  private releaseSubtree(dir: string): void {
    const prefix = dir + path.sep;
    for (const key of [...this.watchers.keys()]) {
      if (key === dir || key.startsWith(prefix)) this.release(key);
    }
  }

  /**
   * One raw event from ONE directory's watch. `filename` is relative to that directory, so the absolute
   * path is ours to rebuild. Act only on "rename" (add/delete/move) — never "change" (a content edit),
   * per scan.mdx §2.2.
   */
  private onRaw(dir: string, eventType: fs.WatchEventType, filename: string | Buffer | null): void {
    if (this.closed) return;
    if (eventType !== "rename") return;
    if (filename == null) return;
    const abs = path.join(dir, filename.toString());
    // lstat, not stat: a symlink to a directory must read as a plain entry so we never watch through it.
    const st = lstatOrNull(abs);
    if (st?.isDirectory()) {
      // A directory appeared (created, moved in, cloned). Extend the watch into it — this is what keeps
      // "recursive" true as the tree grows, and it is where the prune predicate earns its keep a second
      // time: a freshly installed `node_modules` is rejected here and never costs a watch. The walk also
      // ANNOUNCES the files it finds: a directory renamed into the root arrives as this one event, so
      // its contents would otherwise never be reported (see bindTree).
      if (this.opts.shouldWatch(abs, path.basename(abs))) void this.bindTree(abs, true);
      return; // the directory itself is not payload — the files it brought are
    }
    if (!st && this.watchers.has(abs)) this.releaseSubtree(abs); // a watched directory just vanished
    this.opts.onChange(abs);
  }
}

/** Bind a pruned recursive watch over `root`. Binding starts immediately; await `.ready` for the walk. */
export function watchTreePruned(root: string, opts: PrunedWatchOpts): PrunedWatch {
  return new PrunedTreeWatch(root, opts);
}
