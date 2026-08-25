// SLICE 12 — the watcher's new reaction: invalidate the ancestor chain, don't kick a scan.
//
// WHAT THESE PIN, and why each one matters:
//   * the chain reaches every ANCESTOR, because the interest tint of a grandparent is a claim about a
//     subtree that just changed while the grandparent's own mtime did not — the staleness the old
//     `startScan("manual")` never fixed either;
//   * it stops at the filesystem root, because `path.dirname("/")` is `"/"` and a naive loop there does not
//     terminate;
//   * and it drops NOTHING it was not asked to drop, because "clear the cache" would re-arm a
//     120,000-`statSync` interest walk for every open column — the same write amplification in a new coat.
import { test, beforeEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FsListing } from "@lfb/shared";
import { getListingCached, putListing, invalidateFsCachesForPath, clearListingCache } from "./fsindex.service.js";

// Real directories: `putListing` stamps an mtime guard off a real `statSync` and skips caching without one.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-invalidate-"));
const A = path.join(ROOT, "a");
const B = path.join(A, "b");
const C = path.join(B, "c");
const SIBLING = path.join(A, "sibling");
fs.mkdirSync(C, { recursive: true });
fs.mkdirSync(SIBLING, { recursive: true });

const listing = (dir: string): FsListing => ({
  root: dir,
  parent: path.dirname(dir),
  home: os.homedir(),
  entries: [],
  truncated: false,
});

beforeEach(() => {
  clearListingCache();
});

test("one added file forgets its parent AND every ancestor, in both hidden variants", () => {
  for (const d of [ROOT, A, B, C, SIBLING]) {
    putListing(d, false, listing(d));
    putListing(d, true, listing(d));
  }
  const dropped = invalidateFsCachesForPath(path.join(C, "clip.mp4"));

  for (const d of [ROOT, A, B, C]) {
    assert.equal(getListingCached(d, false), null, `${d} (visible) must be forgotten`);
    assert.equal(getListingCached(d, true), null, `${d} (hidden) must be forgotten — hidden is a live toggle`);
  }
  assert.ok(dropped >= 4, `the chain reported ${dropped} drops; at least the four ancestors were cached`);
});

test("a SIBLING subtree is untouched — this is targeted invalidation, not a cache flush", () => {
  putListing(SIBLING, false, listing(SIBLING));
  putListing(C, false, listing(C));
  invalidateFsCachesForPath(path.join(C, "clip.mp4"));
  assert.notEqual(getListingCached(SIBLING, false), null, "the sibling's listing must survive");
});

test("the walk terminates at the filesystem root", () => {
  // `path.dirname("/")` is `"/"`, so a loop that only compares to `path.sep` never ends. A file directly at
  // the root is the shortest chain there is and must return, not hang.
  const n = invalidateFsCachesForPath(path.join(path.parse(ROOT).root, "at-the-root.mp4"));
  assert.equal(typeof n, "number");
});

test("invalidating a path nothing has cached is free and drops nothing", () => {
  assert.equal(invalidateFsCachesForPath(path.join(C, "never-listed.mp4")), 0);
});

test("a relative path is resolved before the chain is walked", () => {
  // The watcher joins `root` + the OS-reported filename, so its paths are absolute — but a caller that
  // passed a relative one would otherwise invalidate a chain under the process cwd and silently do nothing.
  putListing(process.cwd(), false, listing(process.cwd()));
  assert.ok(invalidateFsCachesForPath("some-file.mp4") >= 1, "resolved against cwd, so cwd's listing is dropped");
});
