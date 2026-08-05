// THE WRITE SWITCH — settings `git_backbone.auto_commit` OFF makes every backbone READ-ONLY.
//
// The contract these tests pin down: with the switch off, a cycle still brings the user's other
// computers' edits here (fetch + fast-forward), but this machine may not author ANYTHING — no
// checkpoint commit, no merge commit, no SDL write-back commit, no push. A remote that cannot be
// fast-forwarded is SURFACED as a problem, never merged (a merge is a commit). The switch is read
// live from config.yaml, so flipping it needs no restart.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { GitBackbone, type GitCycleResult } from "./git.service.js";
import { clearAppConfigCache } from "../store-model/config.service.js";

const dirs: string[] = [];
let prevStateDir: string | undefined;

beforeEach(() => {
  // Own state dir per test: the switch lives in config.yaml, and writing the shared vitest baseline
  // state root would bleed the OFF setting into concurrently running spec files.
  prevStateDir = process.env.LFB_STATE_DIR;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-autocommit-state-"));
  dirs.push(state);
  process.env.LFB_STATE_DIR = state;
  clearAppConfigCache();
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.LFB_STATE_DIR;
  else process.env.LFB_STATE_DIR = prevStateDir;
  clearAppConfigCache();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function setAutoCommit(enabled: boolean): void {
  const state = process.env.LFB_STATE_DIR!;
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "config.yaml"), YAML.stringify({ git_backbone: { auto_commit: enabled } }));
  clearAppConfigCache();
}

/** A bare origin plus two clones — `peer` plays the user's other computer, `local` is this machine. */
function originWithTwoClones(): { origin: string; peer: string; local: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-autocommit-"));
  dirs.push(root);
  const origin = path.join(root, "origin.git");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "-b", "main");
  const seed = (dir: string): void => {
    git(root, "clone", "-q", origin, dir);
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test");
  };
  const peer = path.join(root, "peer");
  const local = path.join(root, "local");
  seed(peer);
  fs.mkdirSync(path.join(peer, "devices"));
  fs.writeFileSync(path.join(peer, "devices", "peer.yaml"), "schema_version: 1\n");
  git(peer, "add", "-A");
  git(peer, "commit", "-qm", "seed");
  git(peer, "push", "-q", "origin", "main");
  seed(local);
  return { origin, peer, local };
}

function commitCount(dir: string): number {
  return parseInt(git(dir, "rev-list", "--count", "HEAD").trim(), 10);
}

describe("git_backbone.auto_commit OFF — the backbone is read-only", () => {
  it("pull still fast-forwards the peer's edits in, without authoring a commit", async () => {
    setAutoCommit(false);
    const { peer, local } = originWithTwoClones();
    fs.writeFileSync(path.join(peer, "devices", "peer.yaml"), "schema_version: 1\nupdated: yes\n");
    git(peer, "add", "-A");
    git(peer, "commit", "-qm", "peer edit");
    git(peer, "push", "-q", "origin", "main");

    const backbone = await GitBackbone.resolve("test-storage", local);
    expect(backbone).not.toBeNull();
    const result: GitCycleResult = { ran: true };
    await backbone!.pull(result);

    expect(result.fetched).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.problem).toBeUndefined();
    expect(git(local, "rev-parse", "HEAD")).toBe(git(peer, "rev-parse", "HEAD"));
    // Fast-forward only — this machine authored nothing, and the dirty-tree heals were not written.
    expect(commitCount(local)).toBe(commitCount(peer));
    expect(fs.existsSync(path.join(local, ".gitattributes"))).toBe(false);
  });

  it("pull surfaces a diverged remote as a problem instead of creating a merge commit", async () => {
    setAutoCommit(false);
    const { peer, local } = originWithTwoClones();
    fs.writeFileSync(path.join(local, "local.txt"), "local\n");
    git(local, "add", "-A");
    git(local, "commit", "-qm", "local divergence");
    fs.writeFileSync(path.join(peer, "peer.txt"), "peer\n");
    git(peer, "add", "-A");
    git(peer, "commit", "-qm", "peer edit");
    git(peer, "push", "-q", "origin", "main");

    const backbone = await GitBackbone.resolve("test-storage", local);
    const before = git(local, "rev-parse", "HEAD");
    const result: GitCycleResult = { ran: true };
    await backbone!.pull(result);

    expect(result.fetched).toBe(true);
    expect(result.merged).toBeFalsy();
    expect(result.problem).toMatch(/Auto-commit is disabled/);
    expect(git(local, "rev-parse", "HEAD")).toBe(before); // no merge commit, HEAD untouched
  });

  it("still fast-forwards when this machine's OWN generated text is dirty in the way", async () => {
    // THE STEADY STATE OF THE SWITCH, not an edge case. With auto-commit off `checkpointOwnWrites()` is
    // skipped — it is a commit — but everything that WRITES the tree carries on every pass (the device file,
    // the manifest, the mirrored repos/ subtree; pin.service.ts writes them regardless of Git). So the tree
    // is permanently dirty with LFB's own text, and a `--ff-only` that touches any of it aborts with "Your
    // local changes … would be overwritten by merge" — the exact abort the checkpoint was invented to kill,
    // every cycle, forever. Read-only would then mean "does not sync at all".
    setAutoCommit(false);
    const { peer, local } = originWithTwoClones();
    fs.writeFileSync(path.join(peer, "devices", "peer.yaml"), "schema_version: 1\nfrom: peer\n");
    git(peer, "add", "-A");
    git(peer, "commit", "-qm", "peer edit");
    git(peer, "push", "-q", "origin", "main");
    // …and this machine has the same LFB-owned file dirty, exactly as a pass would leave it.
    fs.writeFileSync(path.join(local, "devices", "peer.yaml"), "schema_version: 1\nlocally: regenerated\n");

    const backbone = await GitBackbone.resolve("test-storage", local);
    const before = commitCount(local);
    const result: GitCycleResult = { ran: true };
    await backbone!.pull(result);

    expect(result.problem).toBeUndefined();
    expect(result.merged).toBe(true);
    expect(git(local, "rev-parse", "HEAD")).toBe(git(peer, "rev-parse", "HEAD"));
    expect(fs.readFileSync(path.join(local, "devices", "peer.yaml"), "utf8")).toContain("from: peer");
    // Nothing was authored to achieve it — the whole point of the switch.
    expect(commitCount(local)).toBe(before + 1); // the fast-forward itself, i.e. the peer's commit
    expect(git(local, "log", "-1", "--format=%s").trim()).toBe("peer edit");
  });

  it("never touches a file of the user's own that blocks the fast-forward — it names it", async () => {
    setAutoCommit(false);
    const { peer, local } = originWithTwoClones();
    fs.writeFileSync(path.join(peer, "notes.txt"), "peer's line\n");
    git(peer, "add", "-A");
    git(peer, "commit", "-qm", "peer note");
    git(peer, "push", "-q", "origin", "main");
    git(local, "fetch", "-q", "origin");
    git(local, "merge", "-q", "--ff-only", "origin/main");
    fs.writeFileSync(path.join(peer, "notes.txt"), "peer's second line\n");
    git(peer, "add", "-A");
    git(peer, "commit", "-qm", "peer note 2");
    git(peer, "push", "-q", "origin", "main");
    fs.writeFileSync(path.join(local, "notes.txt"), "MY UNSAVED WORK\n"); // not LFB's to clear

    const backbone = await GitBackbone.resolve("test-storage", local);
    const result: GitCycleResult = { ran: true };
    await backbone!.pull(result);

    expect(result.merged).toBeFalsy();
    expect(result.problem).toMatch(/notes\.txt/);
    expect(fs.readFileSync(path.join(local, "notes.txt"), "utf8")).toBe("MY UNSAVED WORK\n");
  });

  // Root ignores the permission bits this test relies on, so it could only ever pass vacuously there.
  it.skipIf(process.getuid?.() === 0)("says the tree is still in the way, not that the branch diverged", async () => {
    // A clear that CANNOT LAND — a file another process holds open, a directory the account may not write
    // (the common shape on Windows, which is the platform this whole path was hardened for) — leaves git
    // naming the very same paths. Reporting that as "diverged, reconciling would require a merge commit"
    // sends the user to `git merge` for a problem no merge can fix, and hides the file that is actually
    // stuck. The two states are distinguishable and must be reported apart.
    setAutoCommit(false);
    const { peer, local } = originWithTwoClones();
    fs.writeFileSync(path.join(peer, "devices", "peer.yaml"), "schema_version: 1\nfrom: peer\n");
    git(peer, "add", "-A");
    git(peer, "commit", "-qm", "peer edit");
    git(peer, "push", "-q", "origin", "main");
    fs.writeFileSync(path.join(local, "devices", "peer.yaml"), "schema_version: 1\nlocally: regenerated\n");
    const devices = path.join(local, "devices");
    fs.chmodSync(devices, 0o555); // git can read it, and can restore nothing into it

    const backbone = await GitBackbone.resolve("test-storage", local);
    const before = git(local, "rev-parse", "HEAD");
    const result: GitCycleResult = { ran: true };
    try {
      await backbone!.pull(result);
    } finally {
      fs.chmodSync(devices, 0o755);
    }

    expect(result.merged).toBeFalsy();
    expect(result.problem).toMatch(/devices\/peer\.yaml/);
    expect(result.problem).not.toMatch(/diverged/);
    expect(git(local, "rev-parse", "HEAD")).toBe(before);
  });

  it("commitAndPush commits nothing and pushes nothing, even with staged-worthy SDL changes", async () => {
    setAutoCommit(false);
    const { origin, local } = originWithTwoClones();
    fs.mkdirSync(path.join(local, "devices"), { recursive: true });
    fs.writeFileSync(path.join(local, "devices", "local.yaml"), "schema_version: 1\n");

    const backbone = await GitBackbone.resolve("test-storage", local);
    const before = commitCount(local);
    const result: GitCycleResult = { ran: true };
    await backbone!.commitAndPush(result);

    expect(result.committed).toBeFalsy();
    expect(result.pushed).toBeFalsy();
    expect(commitCount(local)).toBe(before);
    expect(git(origin, "rev-list", "--count", "main").trim()).toBe(String(before)); // origin untouched
  });

  it("flipping the switch back ON restores the write-back with no restart", async () => {
    setAutoCommit(false);
    const { local } = originWithTwoClones();
    fs.mkdirSync(path.join(local, "devices"), { recursive: true });
    fs.writeFileSync(path.join(local, "devices", "local.yaml"), "schema_version: 1\n");

    const backbone = await GitBackbone.resolve("test-storage", local);
    const off: GitCycleResult = { ran: true };
    await backbone!.commitAndPush(off);
    expect(off.committed).toBeFalsy();

    setAutoCommit(true); // read live — same process, same backbone instance
    const on: GitCycleResult = { ran: true };
    await backbone!.commitAndPush(on);
    expect(on.committed).toBe(true);
    expect(on.pushed).toBe(true);
  });
});
