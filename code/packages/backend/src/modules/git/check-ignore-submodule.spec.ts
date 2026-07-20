// SUBMODULE-POISONED check-ignore BATCHES (the ⊘ Ignore column must come from git — pm/decisions.mdx §1.1).
//
// Proven live (160 hits in error.err): `git check-ignore --stdin` aborts the WHOLE batch with
//   fatal: Pathspec '<abs>' is in submodule '<rel>'
// when ANY candidate path lies inside a submodule/gitlink, so one bad path erased git truth for the
// entire repo (bigNotIgnored + the ⊘ icon went blind). checkIgnore/checkIgnoreAsync now split the batch
// at the reported submodule boundary: paths inside are answered by the SUBMODULE's own ignore rules
// (its working tree IS git truth for files that live there), the remainder retries against the parent.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkIgnore, checkIgnoreAsync, checkIgnoreVerbose } from "./git.service.js";

let parent: string;
let ignoredInParent: string;
let ignoredInSub: string;
let notIgnored: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

beforeAll(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-checkignore-sub-"));
  git(parent, "init", "-q");
  fs.writeFileSync(path.join(parent, ".gitignore"), "*.log\n");

  // A nested repo with its OWN ignore rule, registered in the parent index as a gitlink (160000) —
  // exactly the shape that made real check-ignore batches die with "is in submodule".
  const sub = path.join(parent, "sub");
  fs.mkdirSync(sub);
  git(sub, "init", "-q");
  git(sub, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  fs.writeFileSync(path.join(sub, ".gitignore"), "*.mp4\n");
  const sha = git(sub, "rev-parse", "HEAD").trim();
  git(parent, "update-index", "--add", "--cacheinfo", `160000,${sha},sub`);

  ignoredInParent = path.join(parent, "big.log");
  ignoredInSub = path.join(sub, "movie.mp4");
  notIgnored = path.join(parent, "keep.txt");

  // Sanity: the raw batched invocation really does die on this fixture (the bug being guarded).
  expect(() =>
    execFileSync("git", ["check-ignore", "--stdin"], { cwd: parent, input: ignoredInSub + "\n", encoding: "utf8" }),
  ).toThrow(/is in submodule/);
});

afterAll(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

describe("checkIgnore — a submodule-contained path no longer poisons the batch", () => {
  it("sync: parent rules still answered, submodule paths answered by the submodule's own rules", () => {
    const ignored = checkIgnore(parent, [ignoredInParent, ignoredInSub, notIgnored]);
    expect(ignored.has(ignoredInParent)).toBe(true); // git truth for the rest of the repo survives
    expect(ignored.has(ignoredInSub)).toBe(true); // *.mp4 — the SUBMODULE's rule, not the parent's
    expect(ignored.has(notIgnored)).toBe(false);
  });

  it("async twin behaves identically", async () => {
    const ignored = await checkIgnoreAsync(parent, [ignoredInParent, ignoredInSub, notIgnored]);
    expect(ignored.has(ignoredInParent)).toBe(true);
    expect(ignored.has(ignoredInSub)).toBe(true);
    expect(ignored.has(notIgnored)).toBe(false);
  });

  it("verbose variant reports the submodule's own rule for a submodule path", () => {
    const rules = checkIgnoreVerbose(parent, [ignoredInParent, ignoredInSub, notIgnored]);
    expect(rules.get(ignoredInParent)?.pattern).toBe("*.log");
    expect(rules.get(ignoredInSub)?.pattern).toBe("*.mp4");
    expect(rules.has(notIgnored)).toBe(false);
  });

  it("exit-1 (nothing ignored) is still a normal empty result, not a failure", () => {
    expect(checkIgnore(parent, [notIgnored]).size).toBe(0);
  });
});
