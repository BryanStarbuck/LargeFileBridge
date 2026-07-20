// Locks the legacy artifact-ignore HEALER (artifact_placement_policy.mdx §1.1.2, gitignore.service.ts
// `repairLegacyArtifactIgnores`). The defect it repeals, proven live on charlie-kirk 2026-07-20: three
// lines written by since-deleted LFB nudge code (`.lfbridge/`, `*.transcription`, `*.ai_description`)
// made 158 AI descriptions + 59 transcripts invisible to git, stranding them on one computer with a
// clean `git status`. The healer must remove EXACTLY those lines and nothing else — every user rule
// survives byte-for-byte — and it must be idempotent and SDL-safe.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  repairLegacyArtifactIgnores,
  legacyArtifactIgnoreLines,
  LEGACY_ARTIFACT_IGNORE_LINES,
} from "./gitignore.service.js";
import { clearStorageTypeCache } from "../storage/storage-type.service.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-legacy-ignores-"));
  clearStorageTypeCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  clearStorageTypeCache();
});

/** A plain working repo: a `.git/` dir and no SDL descriptor / naming. */
function makeWorkingRepo(gitignore: string | null): string {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (gitignore !== null) fs.writeFileSync(path.join(dir, ".gitignore"), gitignore, "utf8");
  return dir;
}

describe("repairLegacyArtifactIgnores (the charlie-kirk strand healer)", () => {
  it("removes exactly the legacy nudge lines and preserves every user rule byte-for-byte", () => {
    const root = makeWorkingRepo(
      [
        "# user comment",
        "node_modules",
        "videos/",
        ".lfbridge/",
        "*.transcription",
        "*.ai_description",
        "/site/static/img/cover.png",
        "",
      ].join("\n"),
    );
    const removed = repairLegacyArtifactIgnores(root);
    expect(removed.sort()).toEqual([".lfbridge/", "*.ai_description", "*.transcription"].sort());
    const body = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(body).toBe(["# user comment", "node_modules", "videos/", "/site/static/img/cover.png", ""].join("\n"));
  });

  it("is idempotent — a second pass finds nothing and does not rewrite", () => {
    const root = makeWorkingRepo(".lfbridge/\nkeep-me\n");
    expect(repairLegacyArtifactIgnores(root)).toEqual([".lfbridge/"]);
    const after = fs.statSync(path.join(root, ".gitignore")).mtimeMs;
    expect(repairLegacyArtifactIgnores(root)).toEqual([]);
    expect(fs.statSync(path.join(root, ".gitignore")).mtimeMs).toBe(after);
  });

  it("handles the anchored and bare variants", () => {
    const root = makeWorkingRepo("/.lfbridge/\n.lfbridge\nuser-rule\n");
    expect(repairLegacyArtifactIgnores(root).length).toBe(2);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe("user-rule\n");
  });

  it("no-ops on a repo with no .gitignore and on a dir with no .git", () => {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    expect(repairLegacyArtifactIgnores(dir)).toEqual([]); // no .gitignore
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-no-git-"));
    try {
      fs.writeFileSync(path.join(bare, ".gitignore"), ".lfbridge/\n", "utf8");
      expect(repairLegacyArtifactIgnores(bare)).toEqual([]); // not a git repo
      expect(fs.readFileSync(path.join(bare, ".gitignore"), "utf8")).toBe(".lfbridge/\n");
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it("never touches an SDL (kind beats .git presence) — ensureSdlCommittable owns those", () => {
    // The `<name>_large_files_bridge` naming convention classifies the root as an SDL.
    const sdl = path.join(dir, "personal_large_files_bridge");
    fs.mkdirSync(path.join(sdl, ".git"), { recursive: true });
    fs.writeFileSync(path.join(sdl, ".gitignore"), ".lfbridge/\n", "utf8");
    expect(repairLegacyArtifactIgnores(sdl)).toEqual([]);
    expect(fs.readFileSync(path.join(sdl, ".gitignore"), "utf8")).toBe(".lfbridge/\n");
  });

  it("legacyArtifactIgnoreLines is a pure read — reports without mutating", () => {
    const root = makeWorkingRepo(".lfbridge/\n*.ai_description\nuser\n");
    expect(legacyArtifactIgnoreLines(root).sort()).toEqual([".lfbridge/", "*.ai_description"].sort());
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(".lfbridge/");
  });

  it("the constant covers every shape the deleted nudges ever wrote", () => {
    for (const line of [".lfbridge/", ".lfbridge", "/.lfbridge/", "/.lfbridge", "*.transcription", "*.ai_description"]) {
      expect(LEGACY_ARTIFACT_IGNORE_LINES.has(line)).toBe(true);
    }
  });
});
