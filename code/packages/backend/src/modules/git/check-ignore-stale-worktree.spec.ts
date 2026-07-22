// STALE-WORKTREE gitlinks must not be treated as usable git working trees.
//
// Proven live (error.err, every scan cycle Jul 20–22): a Claude Code agent worktree at
//   …/Documentation_ACT3_Docu/.claude/worktrees/agent-ad8c59e6
// had a `.git` FILE pointing at a gitdir under the repo's OLD path (the repo was later moved to
// act3/parked/ without `git worktree prune`), so every git command run inside it fatals
//   fatal: not a git repository: (null)
// isGitWorkingTree() passed it on mere `.git` existence, the check-ignore submodule split then
// recursed INTO the dead worktree as a repo root, and the resulting spawn failure WARNed on every
// scan. The contract now: a `.git` pointer file whose gitdir target does not exist is NOT a working
// tree — the split's "no usable submodule tree → conservatively not ignored" branch takes over.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isGitWorkingTree } from "../store-model/units.service.js";
import { checkIgnore } from "./git.service.js";

let parent: string;
let staleWt: string;
let inStaleWt: string;
let ignoredInParent: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

beforeAll(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-stale-wt-"));
  git(parent, "init", "-q");
  fs.writeFileSync(path.join(parent, ".gitignore"), "*.log\n");

  // The stale worktree: a `.git` FILE whose gitdir target no longer exists (the parent repo moved),
  // registered in the parent index as a gitlink so a check-ignore batch splits at its boundary.
  staleWt = path.join(parent, "wt");
  fs.mkdirSync(staleWt);
  fs.writeFileSync(path.join(staleWt, ".git"), `gitdir: ${path.join(parent, "gone", ".git", "worktrees", "wt")}\n`);
  git(parent, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  const sha = git(parent, "rev-parse", "HEAD").trim();
  git(parent, "update-index", "--add", "--cacheinfo", `160000,${sha},wt`);

  inStaleWt = path.join(staleWt, "img.jpg");
  ignoredInParent = path.join(parent, "big.log");
});

afterAll(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

describe("isGitWorkingTree — gitlink pointer files are verified, not trusted", () => {
  it("rejects a stale worktree whose gitdir target is gone", () => {
    expect(isGitWorkingTree(staleWt)).toBe(false);
  });

  it("accepts a normal repo (.git directory)", () => {
    expect(isGitWorkingTree(parent)).toBe(true);
  });

  it("accepts a HEALTHY linked worktree (gitdir target exists)", () => {
    const wtDir = path.join(os.tmpdir(), `lfb-healthy-wt-${process.pid}`);
    try {
      git(parent, "worktree", "add", "-q", wtDir);
      expect(isGitWorkingTree(wtDir)).toBe(true);
    } finally {
      fs.rmSync(wtDir, { recursive: true, force: true });
      try {
        git(parent, "worktree", "prune");
      } catch {
        /* fixture cleanup only */
      }
    }
  });

  it("rejects a dir with no .git at all", () => {
    expect(isGitWorkingTree(os.tmpdir())).toBe(false);
  });
});

describe("checkIgnore — a stale-worktree gitlink no longer poisons the batch or recurses into a dead tree", () => {
  it("answers the rest of the repo and conservatively reports stale-worktree paths as not ignored", () => {
    const ignored = checkIgnore(parent, [ignoredInParent, inStaleWt]);
    expect(ignored.has(ignoredInParent)).toBe(true); // parent git truth survives the split
    expect(ignored.has(inStaleWt)).toBe(false); // dead tree can't answer → conservative "not ignored"
  });
});
