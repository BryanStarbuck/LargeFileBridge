// GIT WORKING-TREE CONTENTION on a storage's backbone repo — the defect that filled `error.err` for days:
//
//   [WARN] [pin] error: Your local changes to the following files would be overwritten by merge:
//   [WARN] [pin] 	repos/60e5afc9c4/repo_storage.yaml
//   [WARN] [pin] Aborting
//   [WARN] [pin] error: The following untracked working tree files would be overwritten by merge:
//
// LFB writes `repos/<repoUid>/repo_storage.yaml` (and the rest of the mirrored tracking subtree) into the
// SDL's working tree from the SCAN path, then the backbone cycle pulls WITHOUT having committed it. Git
// refuses the merge, the cycle aborts, and the storage stops converging between the user's computers —
// which is the whole product. The untracked half of it LOOPS forever: the "regenerate" conflict resolution
// `git rm`s the file, the next mirror re-creates it untracked, and the next merge is blocked by it again.
//
// These tests drive REAL git (the same binary the engine uses) through both shapes and assert the merge now
// lands, plus the ownership line that keeps a user's own uncommitted file untouched.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitBackbone, isLfbOwnedSdlPath, parseBlockedPaths, type GitCycleResult } from "./git.service.js";
import { deferWhileBusy, withWorktreeBusy, deferredCount } from "./worktree-gate.js";

describe("isLfbOwnedSdlPath — what LFB may commit/regenerate in its OWN storage repo", () => {
  it("owns the mirrored tracking subtree, the SDL root payload and its git control files", () => {
    for (const p of [
      "repos/83e62afc2c80/repo_storage.yaml",
      "repos/83e62afc2c80/files/videos/clip.mp4.yaml",
      "repos/83e62afc2c80/history/tower.txt",
      "devices/bryan-mac-pro.yaml",
      "manifest.yaml",
      "decisions.yaml",
      "files.yaml",
      "storage.yaml",
      "analysis/whatever.yaml",
      "owner_map.yaml",
      ".gitattributes",
      ".gitignore",
      "videos/clip.mp4.transcription",
      "videos/clip.mp4.ai_description",
    ]) {
      expect(isLfbOwnedSdlPath(p), p).toBe(true);
    }
  });

  it("never claims a file the user wrote — those are never committed, reset, or moved", () => {
    for (const p of ["README.md", "notes/todo.txt", "src/index.ts", "videos/clip.mp4"]) {
      expect(isLfbOwnedSdlPath(p), p).toBe(false);
    }
  });
});

describe("parseBlockedPaths — a merge REFUSED before it started names its blockers only in the error text", () => {
  it("reads the local-changes block", () => {
    const msg = [
      "Updating 4ae9aa1..7eacae4",
      "error: Your local changes to the following files would be overwritten by merge:",
      "\trepos/60e5afc9c4/repo_storage.yaml",
      "Please commit your changes or stash them before you merge.",
      "Aborting",
    ].join("\n");
    expect(parseBlockedPaths(msg)).toEqual(["repos/60e5afc9c4/repo_storage.yaml"]);
  });

  it("reads the untracked block", () => {
    const msg = [
      "Updating ab8f39d..23dede8",
      "error: The following untracked working tree files would be overwritten by merge:",
      "\trepos/83e62afc2c80/repo_storage.yaml",
      "Please move or remove them before you merge.",
      "Aborting",
    ].join("\n");
    expect(parseBlockedPaths(msg)).toEqual(["repos/83e62afc2c80/repo_storage.yaml"]);
  });

  it("returns nothing for an ordinary conflict message (that path has its own resolution ladder)", () => {
    expect(parseBlockedPaths("CONFLICT (content): Merge conflict in manifest.yaml")).toEqual([]);
  });
});

describe("worktree gate — nobody writes into a working copy mid-cycle", () => {
  it("defers a write under a busy root and runs it on release", async () => {
    const root = path.join(os.tmpdir(), "lfb-gate-demo");
    const target = path.join(root, "repos/abc/repo_storage.yaml");
    let ran = 0;
    await withWorktreeBusy(root, async () => {
      expect(deferWhileBusy(target, "mirror:x", () => ran++)).toBe(true);
      expect(deferWhileBusy(target, "mirror:x", () => ran++)).toBe(true); // same key COALESCES
      expect(deferredCount()).toBe(1);
      expect(ran).toBe(0);
    });
    expect(ran).toBe(1);
    // Nothing busy → the caller writes immediately, no deferral.
    expect(deferWhileBusy(target, "mirror:x", () => ran++)).toBe(false);
    expect(ran).toBe(1);
  });
});

// ── real-git integration ────────────────────────────────────────────────────────

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

let tmp = "";
let origin = "";
let peer = "";
let local = "";

function seed(): void {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-worktree-"));
  origin = path.join(tmp, "origin.git");
  peer = path.join(tmp, "peer");
  local = path.join(tmp, "local");
  fs.mkdirSync(origin, { recursive: true });
  git(origin, "init", "--bare", "--initial-branch=main", ".");
  git(tmp, "clone", origin, "peer");
  git(peer, "config", "user.email", "t@example.com");
  git(peer, "config", "user.name", "T");
  fs.writeFileSync(path.join(peer, "storage.yaml"), "storage: {}\n");
  git(peer, "add", "-A");
  git(peer, "commit", "-m", "seed");
  git(peer, "push", "origin", "main");
  git(tmp, "clone", origin, "local");
  git(local, "config", "user.email", "t@example.com");
  git(local, "config", "user.name", "T");
}

/** The peer's computer pushes a change to the mirrored tracking file — what our merge must bring down. */
function peerPushes(rel: string, body: string): void {
  const p = path.join(peer, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  git(peer, "add", "-A");
  git(peer, "commit", "-m", `peer: ${rel}`);
  git(peer, "push", "origin", "main");
}

describe("GitBackbone.pull — an LFB write outstanding must never abort the storage's sync", () => {
  beforeEach(seed);
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("merges when the mirror has left repo_storage.yaml TRACKED-but-dirty (was: 'local changes … Aborting')", async () => {
    const rel = "repos/60e5afc9c4/repo_storage.yaml";
    // The file exists on both sides; the peer changes it, and locally the scan path has just rewritten it.
    peerPushes(rel, "repo_storage:\n  counts: {special: 1}\n");
    git(local, "pull", "origin", "main");
    fs.writeFileSync(path.join(local, rel), "repo_storage:\n  counts: {special: 2}\n");
    peerPushes(rel, "repo_storage:\n  counts: {special: 3}\n");

    const bb = await GitBackbone.resolve("test", local);
    expect(bb).not.toBeNull();
    const result: GitCycleResult = { ran: true };
    await bb!.pull(result);

    expect(result.problem).toBeUndefined();
    expect(result.conflicts ?? []).toEqual([]);
    expect(result.merged).toBe(true);
    expect(git(local, "status", "--porcelain").trim()).toBe(""); // our write was committed, not stranded
  });

  it("merges when the mirror has left repo_storage.yaml UNTRACKED (the self-inflicted forever-loop)", async () => {
    const rel = "repos/83e62afc2c80/repo_storage.yaml";
    // The peer introduces the file; locally the mirror wrote its own untracked copy first.
    fs.mkdirSync(path.dirname(path.join(local, rel)), { recursive: true });
    fs.writeFileSync(path.join(local, rel), "repo_storage:\n  counts: {special: 9}\n");
    peerPushes(rel, "repo_storage:\n  counts: {special: 1}\n");

    const bb = await GitBackbone.resolve("test", local);
    const result: GitCycleResult = { ran: true };
    await bb!.pull(result);

    expect(result.problem).toBeUndefined();
    expect(result.merged).toBe(true);
    // The checkpoint made our copy a real commit, so the merge RAN and the per-file ladder handled the
    // content conflict ("regenerate" — the next scan rewrites this cache from Local Storage). What must
    // never happen again is the abort: repeat the cycle and it still merges cleanly, i.e. no forever-loop.
    fs.mkdirSync(path.dirname(path.join(local, rel)), { recursive: true });
    fs.writeFileSync(path.join(local, rel), "repo_storage:\n  counts: {special: 10}\n");
    peerPushes(rel, "repo_storage:\n  counts: {special: 2}\n");
    const again: GitCycleResult = { ran: true };
    await bb!.pull(again);
    expect(again.problem).toBeUndefined();
    expect(again.merged).toBe(true);
  });

  it("leaves the USER's own uncommitted file completely alone and says so", async () => {
    // A file LFB does not own blocks the merge. The charter is explicit: never destroy a user's work.
    peerPushes("README.md", "# theirs\n");
    fs.writeFileSync(path.join(local, "README.md"), "# MINE, uncommitted\n");

    const bb = await GitBackbone.resolve("test", local);
    const result: GitCycleResult = { ran: true };
    await bb!.pull(result);

    expect(fs.readFileSync(path.join(local, "README.md"), "utf8")).toBe("# MINE, uncommitted\n");
    expect(result.merged).toBeFalsy();
    expect(result.problem).toBeTruthy(); // surfaced, not silently swallowed
  });
});
