// THE RECONCILE LOOKS ONLY AT WHAT GIT SAYS CHANGED (performance.mdx P-64, 2026-11-16).
//
// One reconcile of ~/BGit/all (a 32,753-file mirror subtree) was measured at 857 s of on-thread time, and it
// re-walked that whole subtree on every backbone pull, pin pass and device pass even when nothing had arrived.
// These specs pin the replacement: after one full pass, a pass re-examines only the files whose committed
// content changed in the sync repo — and still lands every one of them exactly as the full walk would.
//
// The proof that NO WALK happens uses a file placed in the mirror WITHOUT committing it: the old walk copied
// it on the very next pass; the incremental pass must not see it until git does.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setSyncRepoMarker, reconcileFromSyncRepo, reconcileFromSyncRepoYielding } from "./tracking-sync.service.js";
import { repoStateDir } from "./tracking-root.service.js";
import { planReconcileDelta, resetReconcileDeltaMemo } from "./reconcile-delta.js";

const REMOTE = "https://github.com/ACT3ai/charlie-kirk.git";
let tmp: string;
let repoRoot: string;
let syncRepo: string;
let mirrorDir: string;
let localDir: string;

const write = (file: string, body: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
};
const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: syncRepo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const commitAll = (msg: string): void => {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
};
const local = (rel: string): string => path.join(localDir, rel);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-recdelta-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  delete process.env.LFB_RECONCILE_DELTA;
  delete process.env.LFB_RECONCILE_FULL_WALK_MS;
  resetReconcileDeltaMemo();
  repoRoot = path.join(tmp, "charlie-kirk");
  fs.mkdirSync(repoRoot, { recursive: true });
  syncRepo = path.join(tmp, "sdl");
  fs.mkdirSync(syncRepo, { recursive: true });
  setSyncRepoMarker(repoRoot, syncRepo, REMOTE);
  const marker = fs.readFileSync(path.join(repoStateDir(repoRoot), ".sync-repo"), "utf8").split("\n");
  mirrorDir = path.join(syncRepo, "repos", marker[1]!.trim());
  localDir = repoStateDir(repoRoot);
  fs.mkdirSync(mirrorDir, { recursive: true });
  git("init", "-q");
  write(path.join(syncRepo, "README"), "sdl\n");
  write(path.join(mirrorDir, "other/a.txt"), "a1\n");
  commitAll("init");
});

afterEach(() => {
  resetReconcileDeltaMemo();
  delete process.env.LFB_STATE_DIR;
  delete process.env.LFB_RECONCILE_DELTA;
  delete process.env.LFB_RECONCILE_FULL_WALK_MS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("reconcile — incremental by git tree (P-64)", () => {
  it("the first pass is a full walk; after it, an unchanged subtree is not walked at all", () => {
    reconcileFromSyncRepo(repoRoot);
    expect(fs.readFileSync(local("other/a.txt"), "utf8")).toBe("a1\n");

    // Placed in the mirror but NOT committed: the old whole-tree walk copied this on the next pass.
    write(path.join(mirrorDir, "other/uncommitted.txt"), "x\n");
    expect(planReconcileDelta(mirrorDir, localDir).plan).toEqual({ kind: "none" });
    reconcileFromSyncRepo(repoRoot);
    expect(fs.existsSync(local("other/uncommitted.txt"))).toBe(false);
  });

  it("a committed change is carried — and ONLY the changed paths are examined", () => {
    reconcileFromSyncRepo(repoRoot);
    write(path.join(mirrorDir, "other/uncommitted.txt"), "x\n"); // stays out of git
    write(path.join(mirrorDir, "other/a.txt"), "a2\n");
    write(path.join(mirrorDir, "deep/new/b.txt"), "b1\n");
    git("add", path.join(mirrorDir, "other/a.txt"), path.join(mirrorDir, "deep/new/b.txt"));
    git("commit", "-q", "-m", "peer");

    const plan = planReconcileDelta(mirrorDir, localDir).plan;
    expect(plan).toEqual({ kind: "paths", paths: ["deep/new/b.txt", "other/a.txt"] });

    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
    expect(fs.readFileSync(local("other/a.txt"), "utf8")).toBe("a2\n");
    expect(fs.readFileSync(local("deep/new/b.txt"), "utf8")).toBe("b1\n");
    expect(fs.existsSync(local("other/uncommitted.txt"))).toBe(false);

    // The memo advanced: the next pass has nothing to do.
    expect(planReconcileDelta(mirrorDir, localDir).plan).toEqual({ kind: "none" });
  });

  it("the yielding driver takes the same incremental path", async () => {
    await reconcileFromSyncRepoYielding(repoRoot);
    write(path.join(mirrorDir, "other/a.txt"), "a3\n");
    commitAll("peer");
    expect(await reconcileFromSyncRepoYielding(repoRoot)).toBe(true);
    expect(fs.readFileSync(local("other/a.txt"), "utf8")).toBe("a3\n");
    expect(await reconcileFromSyncRepoYielding(repoRoot)).toBe(false);
  });

  it("a deletion upstream is skipped (the reconcile never deletes), and the shared documents stay with their merges", () => {
    reconcileFromSyncRepo(repoRoot);
    fs.rmSync(path.join(mirrorDir, "other/a.txt"));
    write(path.join(mirrorDir, ".sync-repo"), "never copied\n"); // LOCAL_ONLY at the top level
    commitAll("peer deletes");
    const plan = planReconcileDelta(mirrorDir, localDir).plan;
    expect(plan.kind).toBe("paths");
    reconcileFromSyncRepo(repoRoot);
    expect(fs.readFileSync(local("other/a.txt"), "utf8")).toBe("a1\n"); // untouched locally
    expect(fs.readFileSync(local(".sync-repo"), "utf8")).not.toBe("never copied\n");
  });

  it("falls back to the FULL walk when the mirror is not a git tree", () => {
    fs.rmSync(path.join(syncRepo, ".git"), { recursive: true, force: true });
    reconcileFromSyncRepo(repoRoot);
    write(path.join(mirrorDir, "other/loose.txt"), "l\n");
    expect(planReconcileDelta(mirrorDir, localDir).plan.kind).toBe("full");
    reconcileFromSyncRepo(repoRoot);
    expect(fs.readFileSync(local("other/loose.txt"), "utf8")).toBe("l\n");
  });

  it("LFB_RECONCILE_DELTA=0 restores the full walk", () => {
    reconcileFromSyncRepo(repoRoot);
    process.env.LFB_RECONCILE_DELTA = "0";
    write(path.join(mirrorDir, "other/uncommitted.txt"), "x\n");
    reconcileFromSyncRepo(repoRoot);
    expect(fs.readFileSync(local("other/uncommitted.txt"), "utf8")).toBe("x\n");
  });

  it("runs a periodic full walk as the backstop", () => {
    process.env.LFB_RECONCILE_FULL_WALK_MS = "1000";
    const t0 = Date.now();
    planReconcileDelta(mirrorDir, localDir, t0).commit();
    expect(planReconcileDelta(mirrorDir, localDir, t0 + 10).plan).toEqual({ kind: "none" });
    expect(planReconcileDelta(mirrorDir, localDir, t0 + 2000).plan).toEqual({ kind: "full", reason: "periodic full walk" });
  });

  it("re-walks fully when this repo's Local Storage was removed", () => {
    reconcileFromSyncRepo(repoRoot);
    fs.rmSync(localDir, { recursive: true, force: true });
    expect(planReconcileDelta(mirrorDir, localDir).plan.kind).toBe("full");
  });

  it("a burst of N commits between passes is ONE bounded pass over their union", () => {
    reconcileFromSyncRepo(repoRoot);
    for (let i = 0; i < 20; i++) {
      write(path.join(mirrorDir, `burst/f${i % 5}.txt`), `v${i}\n`);
      commitAll(`c${i}`);
    }
    const plan = planReconcileDelta(mirrorDir, localDir).plan;
    expect(plan).toEqual({ kind: "paths", paths: [0, 1, 2, 3, 4].map((i) => `burst/f${i}.txt`) });
    reconcileFromSyncRepo(repoRoot);
    expect(fs.readFileSync(local("burst/f4.txt"), "utf8")).toBe("v19\n");
  });
});
