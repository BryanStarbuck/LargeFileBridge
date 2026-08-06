// A HALF-FINISHED CLONE MUST NOT WEDGE A STORAGE'S BACKBONE FOREVER (git_backbone.mdx §3.2).
//
// A URL remote has no local checkout, so LFB clones it once into a machine-local cache at
// `pin/s/<id>/git/` and drives it there. The resolver's only test was `exists(<cache>/.git)` — and if a
// clone died partway (network drop mid-transfer, disk full, the process killed), the cache directory
// exists WITHOUT a `.git`. `git clone` refuses a non-empty target, so from then on every single cycle
// failed on the same directory with the same message: no fetch, no merge, no push, no device registration,
// no artifact delivery — for that storage, permanently, until a human deleted the folder by hand.
//
// The cache is machine-local and rebuildable BY DEFINITION (that is what makes it a cache), so the right
// move is to clear it and clone again, and to leave no debris behind when a clone fails.
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

// The state root the cache is carved out of — redirected per test so nothing touches the real one.
const stateRoot = tempRoot("lfb-clone-state-");
process.env.LFB_STATE_DIR = stateRoot;

const { resolveWorkingCopy } = await import("./git.service.js");
const { storageUnitDir } = await import("../../shared/store/scopes.js");

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A bare repo with one commit, usable as a clone source over a plain filesystem path. */
function originWithCommit(): string {
  const root = tempRoot("lfb-clone-origin-");
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = path.join(root, "seed");
  git(root, "clone", "-q", origin, seed);
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  fs.writeFileSync(path.join(seed, "storage.yaml"), "storage: {}\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "seed");
  git(seed, "push", "-q", "origin", "main");
  return origin;
}

/** `resolveWorkingCopy` treats a `file:///…` remote as a URL, so it takes the CACHE-CLONE path. */
const asUrl = (p: string): string => `file://${p}`;

describe("resolveWorkingCopy — recovering the URL-remote cache clone", () => {
  it("clones a URL remote into the machine-local cache on first use", async () => {
    const dir = await resolveWorkingCopy("storage-fresh", asUrl(originWithCommit()));
    expect(dir).toBe(path.join(storageUnitDir("storage-fresh"), "git"));
    expect(fs.existsSync(path.join(dir!, ".git"))).toBe(true);
  });

  it("re-clones over a cache directory left behind by a clone that never finished", async () => {
    const id = "storage-halfclone";
    // Exactly what a killed clone leaves: the target exists, holds partial content, and has no `.git`.
    const cache = path.join(storageUnitDir(id), "git");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "storage.yaml"), "half-written\n");

    const dir = await resolveWorkingCopy(id, asUrl(originWithCommit()));

    expect(dir).toBe(cache);
    expect(fs.existsSync(path.join(cache, ".git"))).toBe(true); // a REAL checkout, not the debris
    expect(git(cache, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  it("reuses an existing GOOD cache clone instead of re-cloning it", async () => {
    const id = "storage-reuse";
    const remote = asUrl(originWithCommit());
    const first = await resolveWorkingCopy(id, remote);
    // A local-only marker proves the second call did not blow the checkout away and start over.
    fs.writeFileSync(path.join(first!, "local-marker.txt"), "keep me\n");
    const second = await resolveWorkingCopy(id, remote);
    expect(second).toBe(first);
    expect(fs.existsSync(path.join(first!, "local-marker.txt"))).toBe(true);
  });

  it("leaves NO debris when the clone itself fails, so the next cycle starts clean", async () => {
    const id = "storage-badremote";
    const cache = path.join(storageUnitDir(id), "git");

    const dir = await resolveWorkingCopy(id, "file:///nonexistent/definitely-not-a-repo.git");

    expect(dir).toBeNull(); // surfaced as "no backbone this pass", never thrown
    // The failed attempt must not leave the exact half-clone shape the previous test had to recover from.
    expect(fs.existsSync(cache)).toBe(false);
  });
});
