// Locks the ASSERT half of the git-ignore axis (decisions.mdx §7, gitignore.service `ensureFilesIgnored`).
//
// The defect it closes: the axis was only ever applied inside `recordDecision`, on the computer where the
// click happened. A `gitignore: true` event that ARRIVED — a teammate's ⊘, or a §9 policy auto-decision
// made on another machine — folded into this computer's ledger, rendered as ignored in the UI (which reads
// the ledger), and never reached this computer's `.gitignore`. The same pin pass then FETCHED the bytes
// into that repo, so git was left offering to commit the exact file the product exists to keep out of git.
//
// The two properties that make the assert safe to run on every reconcile:
//   • It writes for a file that is NOT ON DISK — the line must exist BEFORE the bytes land, which is why
//     this cannot go through `planGitIgnore` (that engine stats its targets and drops the absent ones).
//   • It never writes a REDUNDANT line. A path any broader rule already covers is left alone, INCLUDING a
//     file that is tracked despite such a rule (`--no-index`) — one more anchored line would not un-track
//     it, it would just grow a shared `.gitignore` by a dead rule per file, on every computer, forever.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureFilesIgnored } from "./gitignore.service.js";
import { clearStorageTypeCache } from "../storage/storage-type.service.js";

let root: string;

/** A REAL git repo — the assert asks git itself which paths a rule already covers. */
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function write(rel: string, body = "x"): void {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

function gitignore(): string {
  try {
    return fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  } catch {
    return "";
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lfb-ensure-ignored-")));
  git("init", "-q");
  git("config", "user.email", "spec@example.com");
  git("config", "user.name", "spec");
  clearStorageTypeCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  clearStorageTypeCache();
});

describe("ensureFilesIgnored — carrying a RECORDED decision onto this computer", () => {
  it("writes the anchored line for a file that is not on disk yet (the arriving-decision case)", () => {
    const r = ensureFilesIgnored(root, ["videos/hero.mov"]);
    expect(r.written).toBe(1);
    expect(gitignore()).toBe("/videos/hero.mov\n");
    // …and the file genuinely lands ignored once the pin pass materializes it (the `.gitignore` itself is
    // the only untracked path git still reports).
    write("videos/hero.mov");
    expect(git("status", "--porcelain").trim()).toBe("?? .gitignore");
  });

  it("is idempotent — a second assert writes nothing and does not rewrite the file", () => {
    ensureFilesIgnored(root, ["videos/hero.mov"]);
    const before = fs.statSync(path.join(root, ".gitignore")).mtimeMs;
    const r = ensureFilesIgnored(root, ["videos/hero.mov"]);
    expect(r).toEqual({ written: 0, alreadyIgnored: 1, tracked: 0, refused: 0 });
    expect(fs.statSync(path.join(root, ".gitignore")).mtimeMs).toBe(before);
  });

  it("adds no redundant line when a BROADER rule already covers the file", () => {
    fs.writeFileSync(path.join(root, ".gitignore"), "*.mp4\n", "utf8");
    write("videos/clip.mp4");
    const r = ensureFilesIgnored(root, ["videos/clip.mp4"]);
    expect(r).toEqual({ written: 0, alreadyIgnored: 1, tracked: 0, refused: 0 });
    expect(gitignore()).toBe("*.mp4\n");
  });

  it("adds no redundant line for a file TRACKED despite a broader rule (--no-index)", () => {
    // The shape that grew the per-file `.mp4` block in a real repo: git withholds an ignore verdict for a
    // tracked path, so the plain probe reads "not ignored" and the writer appends a line that changes
    // nothing — the file stays tracked until someone runs `git rm --cached`.
    write("videos/committed.mp4");
    git("add", "-f", "videos/committed.mp4");
    git("commit", "-qm", "committed");
    fs.writeFileSync(path.join(root, ".gitignore"), "*.mp4\n", "utf8");
    const r = ensureFilesIgnored(root, ["videos/committed.mp4"]);
    expect(r.written).toBe(0);
    expect(gitignore()).toBe("*.mp4\n");
  });

  it("writes NOTHING for a decided file that is already tracked — a line cannot un-track it", () => {
    // The shape measured on a real repo here: 1,880 of 1,896 decided files were already committed. A naive
    // assert appends 1,880 rules that can never fire, to a 128-line shared file, and pushes them to the team.
    // What those files need is `git rm --cached`, which is destructive across computers and not ours to run.
    write("images/committed.jpg");
    git("add", "images/committed.jpg");
    git("commit", "-qm", "committed");
    const r = ensureFilesIgnored(root, ["images/committed.jpg"]);
    expect(r).toEqual({ written: 0, alreadyIgnored: 0, tracked: 1, refused: 0 });
    expect(gitignore()).toBe("");
  });

  it("still writes for the UNTRACKED files in a batch that also holds tracked ones", () => {
    write("images/committed.jpg");
    git("add", "images/committed.jpg");
    git("commit", "-qm", "committed");
    const r = ensureFilesIgnored(root, ["images/committed.jpg", "images/fresh.jpg"]);
    expect(r).toEqual({ written: 1, alreadyIgnored: 0, tracked: 1, refused: 0 });
    expect(gitignore()).toBe("/images/fresh.jpg\n");
  });

  it("preserves existing content byte-for-byte and repairs a missing trailing newline", () => {
    fs.writeFileSync(path.join(root, ".gitignore"), "# mine\nnode_modules/\n*.log", "utf8");
    expect(ensureFilesIgnored(root, ["a/b.mov"]).written).toBe(1);
    expect(gitignore()).toBe("# mine\nnode_modules/\n*.log\n/a/b.mov\n");
  });

  it("folds a Windows-spelled ledger key onto the same POSIX line, once", () => {
    const r = ensureFilesIgnored(root, ["videos\\hero.mov", "videos/hero.mov"]);
    expect(r.written).toBe(1);
    expect(gitignore()).toBe("/videos/hero.mov\n");
  });

  it("refuses a key that does not land inside the repo, and LFB's own travelling text", () => {
    const r = ensureFilesIgnored(root, ["../escape.mov", "/abs.mov", ".lfbridge/manifest.yaml"]);
    expect(r).toEqual({ written: 0, alreadyIgnored: 0, tracked: 0, refused: 3 });
    expect(gitignore()).toBe("");
  });

  it("does nothing at all when the path is not a repo root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-not-a-repo-"));
    try {
      expect(ensureFilesIgnored(outside, ["a.mov"])).toEqual({ written: 0, alreadyIgnored: 0, tracked: 0, refused: 0 });
      expect(fs.existsSync(path.join(outside, ".gitignore"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("writes one line per distinct file across a batch, in one pass", () => {
    fs.writeFileSync(path.join(root, ".gitignore"), "/videos/already.mov\n", "utf8");
    const r = ensureFilesIgnored(root, ["videos/already.mov", "videos/a.mov", "videos/b.mov"]);
    expect(r).toEqual({ written: 2, alreadyIgnored: 1, tracked: 0, refused: 0 });
    expect(gitignore()).toBe("/videos/already.mov\n/videos/a.mov\n/videos/b.mov\n");
  });
});
