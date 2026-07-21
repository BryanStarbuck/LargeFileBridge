// OVERSIZED check-ignore BATCHES (the `spawnSync git EPIPE` storm — git_ignore.mdx §5.4).
//
// Proven live (89 hits in error.err, all on one repo with three submodules and ~1,800 candidates):
// `git check-ignore --stdin` stops reading stdin the moment it hits a fatal. With a SMALL list the whole
// feed already sits in the OS pipe buffer, so spawnSync returns a readable exit-128 + stderr and the
// submodule split recovers. With a list LARGER than the 64 KiB pipe buffer the write is still in flight —
// it fails with EPIPE, stderr is not reliably captured, the split has nothing to parse, and the ENTIRE
// repo lost its git-ignore truth (every file silently reported "not ignored").
//
// The fix batches the stdin feed below the pipe buffer and bisects any batch that still fails, so a poison
// path costs only its own verdict. This spec reproduces the oversized shape and asserts (a) the raw
// invocation really does die with EPIPE on this fixture, and (b) our wrapper still answers correctly.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkIgnoreDetailed, checkIgnoreVerboseDetailed, checkIgnoreAsyncDetailed } from "./git.service.js";

let parent: string;
let sub: string;
let bulk: string[]; // > 64 KiB of paths, with a submodule-contained path first (git aborts immediately)

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

beforeAll(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-checkignore-epipe-"));
  git(parent, "init", "-q");
  fs.writeFileSync(path.join(parent, ".gitignore"), "*.log\n");

  sub = path.join(parent, "sub");
  fs.mkdirSync(sub);
  git(sub, "init", "-q");
  git(sub, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  fs.writeFileSync(path.join(sub, ".gitignore"), "*.mp4\n");
  const sha = git(sub, "rev-parse", "HEAD").trim();
  git(parent, "update-index", "--add", "--cacheinfo", `160000,${sha},sub`);

  // The submodule path FIRST: git fatals on line 1 and closes stdin while we are still writing the rest.
  bulk = [path.join(sub, "movie.mp4")];
  const pad = "x".repeat(80);
  for (let i = 0; i < 2000; i++) bulk.push(path.join(parent, `f_${String(i).padStart(5, "0")}_${pad}.log`));
  expect(bulk.join("\n").length).toBeGreaterThan(64 * 1024); // must exceed the pipe buffer to reproduce
});

afterAll(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

describe("checkIgnore — an oversized --stdin batch no longer loses the whole repo to EPIPE", () => {
  it("the raw single-shot invocation really does fail with EPIPE on this fixture", () => {
    let msg = "";
    try {
      execFileSync("git", ["check-ignore", "--stdin"], {
        cwd: parent,
        input: bulk.join("\n") + "\n",
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/EPIPE|is in submodule/); // the exact shape the log recorded
  });

  it("sync: every path still gets its real verdict, and nothing is UNKNOWN", () => {
    const res = checkIgnoreDetailed(parent, bulk);
    expect(res.unknown.size).toBe(0);
    expect(res.ignored.has(path.join(sub, "movie.mp4"))).toBe(true); // the submodule's own *.mp4 rule
    expect(res.ignored.size).toBe(bulk.length); // every *.log matched the parent's rule
  });

  it("verbose: the owning rule survives the oversized batch too", () => {
    const res = checkIgnoreVerboseDetailed(parent, bulk);
    expect(res.unknown.size).toBe(0);
    expect(res.rules.get(bulk[1])?.pattern).toBe("*.log");
    expect(res.rules.get(path.join(sub, "movie.mp4"))?.pattern).toBe("*.mp4");
  });

  it("async twin behaves identically", async () => {
    const res = await checkIgnoreAsyncDetailed(parent, bulk);
    expect(res.unknown.size).toBe(0);
    expect(res.ignored.size).toBe(bulk.length);
  });

  it("a non-git directory is reported as UNKNOWN, never as 'not ignored'", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-checkignore-nogit-"));
    try {
      const res = checkIgnoreDetailed(plain, [path.join(plain, "movie.mp4")]);
      expect(res.ignored.size).toBe(0);
      expect(res.unknown.size).toBe(1); // "we could not ask git" — the caller must not fold this into false
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
