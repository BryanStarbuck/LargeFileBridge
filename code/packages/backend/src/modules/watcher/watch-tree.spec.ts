// The invariant this file exists to hold: the live watcher binds a kernel watch ONLY to directories the
// scan would actually walk. Filtering events after they arrive is not enough — on Linux each watched
// directory costs one inotify watch, and watching `node_modules` / `.git/objects/**` across a 188-repo
// root exhausted `fs.inotify.max_user_watches` and silently blinded the watcher (scan.mdx §2.2).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeWatchFilter, watchTreePruned, type PrunedWatch } from "./watch-tree.js";

let root: string;
let live: PrunedWatch[] = [];

const mk = (...segs: string[]): string => {
  const p = path.join(root, ...segs);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** Poll until `cond` holds — fs.watch delivers asynchronously, so there is nothing to await on. */
const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
};

const start = async (opts: Partial<Parameters<typeof watchTreePruned>[1]> = {}): Promise<{
  watch: PrunedWatch;
  changed: string[];
  warnings: string[];
}> => {
  const filter = makeWatchFilter(root, opts.shouldWatch ? [] : ["**/ignored-by-glob/**"]);
  const changed: string[] = [];
  const warnings: string[] = [];
  const watch = watchTreePruned(root, {
    maxDirs: 10_000,
    shouldWatch: filter.dirOk,
    onChange: (abs) => changed.push(abs),
    onWarn: (m) => warnings.push(m),
    ...opts,
  });
  live.push(watch);
  await watch.ready;
  return { watch, changed, warnings };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-watch-tree-"));
});

afterEach(() => {
  for (const w of live) w.close();
  live = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("makeWatchFilter", () => {
  it("rejects the scanner's hard-skip directories and macOS bundles", () => {
    const f = makeWatchFilter(root, []);
    expect(f.dirOk(path.join(root, "src"), "src")).toBe(true);
    expect(f.dirOk(path.join(root, "node_modules"), "node_modules")).toBe(false);
    expect(f.dirOk(path.join(root, ".git"), ".git")).toBe(false);
    expect(f.dirOk(path.join(root, "dist"), "dist")).toBe(false);
    expect(f.dirOk(path.join(root, "Glance.app"), "Glance.app")).toBe(false);
  });

  it("prunes a directory named by scanner.ignore_globs, in all three gitignore spellings", () => {
    // `**/x/**` matches only paths INSIDE x — the probe-child is what makes the DIRECTORY prunable.
    for (const glob of ["**/vault/**", "**/vault/", "**/vault"]) {
      const f = makeWatchFilter(root, [glob]);
      expect(f.dirOk(path.join(root, "a", "vault"), "vault")).toBe(false);
      expect(f.dirOk(path.join(root, "a", "keep"), "keep")).toBe(true);
    }
  });

  it("keeps an ignored directory bound when a negation could re-include something under it", () => {
    const f = makeWatchFilter(root, ["**/vault/**", "!**/vault/big.mp4"]);
    expect(f.dirOk(path.join(root, "vault"), "vault")).toBe(true);
    expect(f.pathOk(path.join(root, "vault", "big.mp4"))).toBe(true);
    expect(f.pathOk(path.join(root, "vault", "junk.txt"))).toBe(false);
  });

  it("drops event paths under a skipped directory, and anything outside the root", () => {
    const f = makeWatchFilter(root, ["**/ignored-by-glob/**"]);
    expect(f.pathOk(path.join(root, "src", "movie.mp4"))).toBe(true);
    expect(f.pathOk(path.join(root, "a", "node_modules", "pkg", "demo.mp4"))).toBe(false);
    expect(f.pathOk(path.join(root, ".git", "objects", "ab", "cd"))).toBe(false);
    expect(f.pathOk(path.join(root, "ignored-by-glob", "movie.mp4"))).toBe(false);
    expect(f.pathOk(path.join(path.dirname(root), "elsewhere", "movie.mp4"))).toBe(false);
  });
});

describe("watchTreePruned", () => {
  it("binds only the directories the scan would walk — never node_modules/.git/build", async () => {
    mk("src", "media");
    mk("node_modules", "left-pad", "deep");
    mk(".git", "objects", "ab");
    mk("web", "dist", "assets");
    mk("ignored-by-glob", "inner");

    const { watch } = await start();

    // root, src, src/media, web — and nothing from the four pruned trees (which hold 9 directories).
    expect(watch.size()).toBe(4);
    expect(watch.truncated()).toBe(false);
  });

  it("reports an added file, and never one added inside a pruned tree", async () => {
    mk("src");
    mk("node_modules", "left-pad");
    const { changed } = await start();

    fs.writeFileSync(path.join(root, "node_modules", "left-pad", "demo.mp4"), "x");
    fs.writeFileSync(path.join(root, "src", "clip.mp4"), "x");

    expect(await until(() => changed.some((p) => p.endsWith("clip.mp4")))).toBe(true);
    expect(changed.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("ignores a content edit — only add/delete matter (scan.mdx §2.2)", async () => {
    const file = path.join(mk("src"), "clip.mp4");
    fs.writeFileSync(file, "x");
    const { changed } = await start();

    fs.writeFileSync(file, "xxxxxxxx"); // rewrite in place — a "change", not a "rename"
    await new Promise((r) => setTimeout(r, 300));

    expect(changed).toEqual([]);
  });

  it("extends into a directory that appears later, but still refuses a fresh node_modules", async () => {
    mk("src");
    const { watch } = await start();
    const before = watch.size();

    fs.mkdirSync(path.join(root, "src", "shoot-2026"));
    expect(await until(() => watch.size() === before + 1)).toBe(true);

    fs.mkdirSync(path.join(root, "src", "node_modules"));
    fs.mkdirSync(path.join(root, "src", "node_modules", "pkg"));
    await new Promise((r) => setTimeout(r, 300));
    expect(watch.size()).toBe(before + 1);
  });

  it("reports the files a directory MOVED INTO the root brought with it", async () => {
    // `mv ~/Downloads/shoot ~/Media/` is ONE kernel event for the directory — the files inside it are
    // never reported, so without announcing them a folder of videos would sit unnoticed until the
    // 4-hour discovery pass. The initial walk must stay silent, though: those files are not news.
    mk("src");
    const { watch, changed } = await start();
    expect(changed).toEqual([]); // the initial walk announces nothing

    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-watch-move-"));
    fs.mkdirSync(path.join(staging, "clips"));
    fs.writeFileSync(path.join(staging, "clips", "b-roll.mp4"), "x");
    fs.writeFileSync(path.join(staging, "shot.mp4"), "x");
    fs.renameSync(staging, path.join(root, "src", "shoot-2026"));

    expect(await until(() => changed.some((p) => p.endsWith("b-roll.mp4")))).toBe(true);
    expect(changed.some((p) => p.endsWith("shot.mp4"))).toBe(true);
    expect(watch.size()).toBe(4); // root, src, src/shoot-2026, src/shoot-2026/clips
  });

  it("takes the watch cap as a ceiling, not a latch — freed watches are usable again", async () => {
    mk("a");
    mk("b");
    const { watch, warnings } = await start({ maxDirs: 2 });
    expect(watch.size()).toBe(2); // root + one of a|b; the other was refused at the cap

    for (const d of ["a", "b"]) fs.rmSync(path.join(root, d), { recursive: true, force: true });
    expect(await until(() => watch.size() === 1)).toBe(true); // the bound one handed its watch back

    fs.mkdirSync(path.join(root, "c"));
    expect(await until(() => watch.size() === 2)).toBe(true); // bound again, no restart needed
    expect(warnings.filter((w) => /live-watch limit/.test(w))).toHaveLength(1); // said once, not per folder
  });

  it("gives the watches back when a watched directory is deleted", async () => {
    mk("src", "a", "b");
    const { watch } = await start();
    expect(watch.size()).toBe(4); // root, src, src/a, src/a/b

    fs.rmSync(path.join(root, "src", "a"), { recursive: true, force: true });
    expect(await until(() => watch.size() === 2)).toBe(true);
  });

  it("announces the watch cap instead of silently covering part of the tree", async () => {
    mk("a", "deep");
    mk("b");
    const { watch, warnings } = await start({ maxDirs: 2 });

    expect(watch.size()).toBe(2);
    expect(watch.truncated()).toBe(true);
    expect(warnings.join(" ")).toMatch(/live-watch limit/);
  });

  it("stops delivering after close()", async () => {
    mk("src");
    const { watch, changed } = await start();
    watch.close();

    fs.writeFileSync(path.join(root, "src", "clip.mp4"), "x");
    await new Promise((r) => setTimeout(r, 300));

    expect(changed).toEqual([]);
    expect(watch.size()).toBe(0);
  });
});
