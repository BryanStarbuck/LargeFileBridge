import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isScanIgnored, makeScanIgnore, rootRelativeGlobs } from "./scan-ignore.js";
import { makeWatchFilter } from "../modules/watcher/watch-tree.js";
import { repoRootGone } from "../modules/storage/tracking-root.service.js";

// 2026-11-16: `/Users/bryan/BGit/all/**` in scanner.ignore_globs matched NOTHING (gitignore reads a leading
// `/` as root-anchored), so the live watcher kept reconciling the 259k-file monorepo on every file event.
describe("scanner.ignore_globs — absolute globs mean the tree they name", () => {
  const root = path.join(os.homedir(), "BGit");

  it("rewrites an absolute glob under the root to the root-anchored form", () => {
    expect(rootRelativeGlobs(root, [path.join(root, "all/**")])).toEqual(["/all/**"]);
    expect(rootRelativeGlobs(root, ["~/BGit/2all/**"])).toEqual(["/2all/**"]);
    expect(rootRelativeGlobs(root, [`!${path.join(root, "all/keep")}`])).toEqual(["!/all/keep"]);
  });

  it("leaves relative and short root-anchored gitignore patterns alone", () => {
    expect(rootRelativeGlobs(root, ["**/node_modules/**", "/build/", "*.tmp", "**/_worktrees/**"])).toEqual([
      "**/node_modules/**",
      "/build/",
      "*.tmp",
      "**/_worktrees/**",
    ]);
  });

  it("drops an absolute glob that lies outside the root", () => {
    expect(rootRelativeGlobs(root, [path.join(os.homedir(), "Elsewhere/**")])).toEqual([]);
  });

  const globs = [path.join(root, "all/**"), path.join(root, "2all/**"), "**/_worktrees/**", "**/node_modules/**"];

  it("excludes the named trees and worktrees, and nothing next to them", () => {
    const ig = makeScanIgnore(root, globs);
    expect(ig.dirIgnored(path.join(root, "all"))).toBe(true);
    expect(ig.dirIgnored(path.join(root, "all/film/code"))).toBe(true);
    expect(ig.pathIgnored(path.join(root, "all/film/x.mp4"))).toBe(true);
    expect(ig.dirIgnored(path.join(root, "2all"))).toBe(true);
    expect(ig.dirIgnored(path.join(root, "act3/_worktrees/foo"))).toBe(true);
    // A sibling whose name merely starts with "all" is NOT excluded.
    expect(ig.dirIgnored(path.join(root, "allied"))).toBe(false);
    expect(ig.dirIgnored(path.join(root, "Bryan_git/LargeFileBridge"))).toBe(false);
    expect(ig.pathIgnored(path.join(root, "Bryan_git/charlie-kirk/videos/a.mp4"))).toBe(false);
  });

  it("the live watcher refuses the ignored trees (the expensive part)", () => {
    const f = makeWatchFilter(root, globs);
    expect(f.dirOk(path.join(root, "all"), "all")).toBe(false);
    expect(f.pathOk(path.join(root, "all/film/code/a.ts"))).toBe(false);
    expect(f.dirOk(path.join(root, "act3/_worktrees"), "_worktrees")).toBe(false);
    expect(f.dirOk(path.join(root, "Bryan_git"), "Bryan_git")).toBe(true);
    expect(f.pathOk(path.join(root, "Bryan_git/x/a.mp4"))).toBe(true);
  });

  it("isScanIgnored answers across several roots", () => {
    expect(isScanIgnored(path.join(root, "all"), [root, "/Volumes/Other"], globs)).toBe(true);
    expect(isScanIgnored(path.join(root, "act3/we_citizens"), [root], globs)).toBe(false);
    expect(isScanIgnored(path.join(root, "all"), [root], [])).toBe(false);
  });
});

describe("repoRootGone — a deleted repo is skipped, not unregistered", () => {
  it("is false for a directory, true for a missing path, and logs once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-gone-"));
    const msgs: string[] = [];
    expect(repoRootGone(dir, (m) => msgs.push(m))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(repoRootGone(dir, (m) => msgs.push(m))).toBe(true);
    expect(repoRootGone(dir, (m) => msgs.push(m))).toBe(true);
    expect(msgs).toHaveLength(1);
    // Back on disk → present again, and a later disappearance is announced again.
    fs.mkdirSync(dir);
    expect(repoRootGone(dir, (m) => msgs.push(m))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(repoRootGone(dir, (m) => msgs.push(m))).toBe(true);
    expect(msgs).toHaveLength(2);
  });
});
