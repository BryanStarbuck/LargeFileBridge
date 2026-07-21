// BUG #15B — a WORKING repo that can no longer fast-forward never converges again, silently, forever.
//
// Live evidence (error.err, 2026-07-20):
//
//   [WARN] [sync] …/charlie-kirk: One-repo detail loaded (charlie-kirk) — cannot fast-forward from origin/main: Updating 42ef2d61..e66f709e
//   [WARN] [sync] error: Your local changes to the following files would be overwritten by merge:
//   [WARN] [sync] 	.gitignore
//   [WARN] [sync]  (local branch diverged or working tree blocks it; not touching a user's repo)
//
// NOT TOUCHING THE USER'S REPO IS CORRECT and is asserted here — no reset, no rebase, no discarded work.
// What was missing is that the refusal existed nowhere but the log, so the user could never learn that
// their second computer's finished transcripts and AI descriptions had stopped arriving. These tests drive
// REAL git through both refusal shapes and assert the recorded block the One-repo page renders.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  convergeWorkingRepoFromOrigin,
  getRepoSyncBlock,
  resetRepoSyncBlocksForTest,
} from "./repo-artifact-sync.service.js";
import { resetOnlineWaitersForTest } from "../../shared/net-transient.js";

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

let tmp = "";
let origin = "";
let peer = "";
let local = "";

beforeEach(() => {
  resetRepoSyncBlocksForTest();
  resetOnlineWaitersForTest();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-converge-"));
  origin = path.join(tmp, "origin.git");
  peer = path.join(tmp, "peer");
  local = path.join(tmp, "local");
  fs.mkdirSync(origin, { recursive: true });
  git(origin, "init", "--bare", "--initial-branch=main", ".");
  git(tmp, "clone", origin, "peer");
  git(peer, "config", "user.email", "t@example.com");
  git(peer, "config", "user.name", "T");
  fs.mkdirSync(path.join(peer, ".lfbridge"), { recursive: true });
  fs.writeFileSync(path.join(peer, ".lfbridge/clip.mp4.transcription"), "first\n");
  fs.writeFileSync(path.join(peer, "notes.txt"), "seed\n");
  git(peer, "add", "-A");
  git(peer, "commit", "-m", "seed");
  git(peer, "push", "origin", "main");
  git(tmp, "clone", origin, "local");
  git(local, "config", "user.email", "t@example.com");
  git(local, "config", "user.name", "T");
});

afterEach(() => {
  resetRepoSyncBlocksForTest();
  resetOnlineWaitersForTest();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** The user's OTHER computer finishes some work and pushes it. */
function peerPushes(rel: string, body: string): void {
  const p = path.join(peer, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  git(peer, "add", "-A");
  git(peer, "commit", "-m", `peer: ${rel}`);
  git(peer, "push", "origin", "main");
}

describe("convergeWorkingRepoFromOrigin — the healthy path still converges", () => {
  it("fast-forwards a clean repo and records no block", async () => {
    peerPushes(".lfbridge/clip.mp4.ai_description", "a description\n");
    const r = await convergeWorkingRepoFromOrigin(local, "test");
    expect(r.converged).toBe(true);
    expect(r.problem).toBeNull();
    expect(fs.existsSync(path.join(local, ".lfbridge/clip.mp4.ai_description"))).toBe(true);
    expect(getRepoSyncBlock(local)).toBeNull();
  });
});

describe("convergeWorkingRepoFromOrigin — a refusal must become something the USER can see", () => {
  it("records a `local-changes` block, names the file in the way, and leaves the user's edit untouched", async () => {
    // The user is mid-edit on a file the incoming commit also touches.
    fs.writeFileSync(path.join(local, "notes.txt"), "the user's unsaved thinking\n");
    peerPushes("notes.txt", "peer's version\n");

    const r = await convergeWorkingRepoFromOrigin(local, "test");
    expect(r.converged).toBe(false);
    expect(r.problem).toMatch(/cannot fast-forward/);

    const block = getRepoSyncBlock(local);
    expect(block?.kind).toBe("local-changes");
    expect(block?.branch).toBe("main");
    expect(block?.paths).toContain("notes.txt");

    // THE GUEST RULE: the user's uncommitted work is exactly as they left it.
    expect(fs.readFileSync(path.join(local, "notes.txt"), "utf8")).toBe("the user's unsaved thinking\n");
  });

  it("records a `diverged` block when this computer has commits the remote does not", async () => {
    fs.writeFileSync(path.join(local, "mine.txt"), "a commit only this computer has\n");
    git(local, "add", "-A");
    git(local, "commit", "-m", "local work");
    peerPushes(".lfbridge/clip.mp4.ai_description", "a description\n");

    const r = await convergeWorkingRepoFromOrigin(local, "test");
    expect(r.converged).toBe(false);

    const block = getRepoSyncBlock(local);
    expect(block?.kind).toBe("diverged");
    expect(block?.paths).toEqual([]);
    // Nothing was rebased, reset or discarded — the local commit is still HEAD.
    expect(git(local, "log", "-1", "--pretty=%s").trim()).toBe("local work");
  });

  it("clears the block as soon as the repo can fast-forward again", async () => {
    fs.writeFileSync(path.join(local, "notes.txt"), "the user's unsaved thinking\n");
    peerPushes("notes.txt", "peer's version\n");
    await convergeWorkingRepoFromOrigin(local, "test");
    expect(getRepoSyncBlock(local)?.kind).toBe("local-changes");

    // The user commits their side, as the recommendation asks them to.
    git(local, "add", "-A");
    git(local, "commit", "-m", "my edit");
    git(local, "fetch", "origin", "main");
    git(local, "merge", "-m", "merge", "origin/main", "-X", "ours");
    git(local, "push", "origin", "main");

    const r = await convergeWorkingRepoFromOrigin(local, "test");
    expect(r.problem).toBeNull();
    expect(getRepoSyncBlock(local)).toBeNull();
  });
});

describe("convergeWorkingRepoFromOrigin — an OFFLINE fetch is postponed, never recorded as a fault", () => {
  it("returns no problem and records NO block when the remote host cannot be resolved", async () => {
    // A host in the reserved `.invalid` TLD can never resolve — the same shape as a closed lid.
    git(local, "remote", "set-url", "origin", "https://lfb-offline-probe.invalid/x/y.git");
    const r = await convergeWorkingRepoFromOrigin(local, "test");
    expect(r.converged).toBe(false);
    expect(r.problem).toBeNull(); // postponed, not failed
    expect(getRepoSyncBlock(local)).toBeNull(); // a DNS blip must never mark a repo bad
  });
});
