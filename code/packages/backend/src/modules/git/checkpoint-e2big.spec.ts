// `spawn E2BIG` — the failure that stalled a whole backbone and looked like three unrelated ones.
//
// `checkpointOwnWrites()` staged and committed the dirty LFB-generated paths by SPREADING them into argv
// (`git add -- <p1> <p2> … <pN>`). argv is capped by the kernel — 1 MiB on macOS, shared with the process
// environment — and a checkpoint on the act3 backbone stages thousands of sidecar YAMLs whose relative
// paths run 80–100 bytes each. Past the cap `spawn` fails with **E2BIG** before git ever starts:
//
//   [2026-08-20T12:38:57.350Z] [WARN] [git] …act3_large_files_bridge: pre-merge checkpoint commit failed:
//                                          Error: spawn E2BIG                       (×5 that day)
//
// The catch swallowed it as "the checkpoint didn't land", so the tree stayed dirty and the merge that
// follows was refused for "local changes would be overwritten" — which is why the SAME repo's
// merge-conflict and push-rejected warnings sit right beside it. One root cause wearing three names.
//
// The fix hands git the pathspec in a NUL-delimited FILE (`--pathspec-from-file` + `--pathspec-file-nul`),
// which has no size ceiling at all. This test proves the ceiling is gone by pushing well past it.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitBackbone } from "./git.service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    // maxRetries: a 6,000-file tree on macOS occasionally races its own rm (ENOTEMPTY).
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024, // 6,000 long paths out of `ls-files` is past the 1 MB default
  });
}

/** Long enough that a few thousand of them clear 1 MiB of argv, and shaped like the real sidecars. */
function relPathFor(i: number): string {
  const bucket = String(i % 97).padStart(4, "0");
  const deep = `${"nested_directory_segment".repeat(2)}/${"another_long_segment_name".repeat(2)}`;
  return `repos/83e62afc2c80/files/${bucket}/${deep}/sidecar_${i}_with_a_realistically_long_name.mp4.yaml`;
}

describe("checkpointOwnWrites — a pathspec bigger than ARG_MAX", () => {
  it("commits thousands of generated sidecars instead of dying with spawn E2BIG", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-e2big-"));
    dirs.push(root);
    const origin = path.join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    const work = path.join(root, "work");
    git(root, "clone", "-q", origin, work);
    git(work, "config", "user.email", "test@example.com");
    git(work, "config", "user.name", "Test");
    fs.writeFileSync(path.join(work, "seed.txt"), "seed\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "seed");
    git(work, "push", "-q", "origin", "main");

    // Enough paths that the spread form is guaranteed to exceed the kernel's argv cap.
    const COUNT = 6000;
    const rels: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const rel = relPathFor(i);
      rels.push(rel);
      const abs = path.join(work, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `file:\n  size: ${i}\n  events: []\n`);
    }
    const argvBytes = rels.reduce((n, r) => n + r.length + 1, 0);
    expect(argvBytes).toBeGreaterThan(1024 * 1024); // the old form could not have survived this

    const backbone = await GitBackbone.resolve("e2big-storage", work);
    // `pull()` is the caller that runs the pre-merge checkpoint; it reports through the result object.
    const res: { ran: boolean; problem?: string } = { ran: true };
    await backbone!.pull(res);
    expect(res.problem).toBeUndefined();

    // The proof: every sidecar is committed, so the tree is clean and a merge could not be refused for
    // "local changes would be overwritten".
    expect(git(work, "status", "--porcelain").trim()).toBe("");
    const tracked = new Set(git(work, "ls-files").split("\n"));
    for (const rel of rels) expect(tracked.has(rel)).toBe(true);
  }, 120_000);
});
