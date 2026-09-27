// The `lfb` merge driver, driven by REAL git (backward_compatibility.md §4.1). The reason it exists is one
// observed shape — two computers each append to a nested YAML sequence and git's line union fuses two items
// into one — so the test builds exactly that shape and merges it, with and without the driver.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { desiredGitattributes, mergeDriverCommand } from "../modules/git/git.service.js";

let repo: string;
const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const read = (rel: string): string => fs.readFileSync(path.join(repo, rel), "utf8");

const event = (p: string, at: string): Record<string, unknown> => ({
  sid: "r:1",
  path: p,
  fingerprint: null,
  asked: false,
  ipfs: false,
  gitignore: false,
  decided_by: "deleted",
  decided_at: at,
});
const ledger = (...events: Record<string, unknown>[]): string => YAML.stringify({ schema_version: 1, events });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-merge-driver-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

/** base → two branches that each RE-STAMP the same record (the charlie-kirk shape) → merge. */
function divergeAndMerge(): { ok: boolean } {
  write("decisions.yaml", ledger(event("img/a.jpg", "2026-09-27T20:00:00.000Z"), event("img/b.jpg", "2026-09-27T20:00:00.000Z")));
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "side");
  write("decisions.yaml", ledger(event("img/a.jpg", "2026-09-27T20:20:18.936Z"), event("img/b.jpg", "2026-09-27T20:00:00.000Z")));
  git("commit", "-qam", "side");
  git("checkout", "-q", "main");
  write("decisions.yaml", ledger(event("img/a.jpg", "2026-09-27T20:21:18.540Z"), event("img/b.jpg", "2026-09-27T20:00:00.000Z")));
  git("commit", "-qam", "main");
  try {
    git("merge", "--no-edit", "side");
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

describe(".gitattributes: the driver block goes LAST and never flaps", () => {
  it("keeps every union line an older build expects, and appends the driver block after them", () => {
    const old = "* text=auto eol=lf\n\ndecisions.yaml merge=union\nmanifest.yaml merge=union\n";
    const next = desiredGitattributes(old);
    expect(next.indexOf("decisions.yaml merge=union")).toBeLessThan(next.indexOf("decisions.yaml merge=lfb"));
    expect(desiredGitattributes(next)).toBe(next); // idempotent: no rewrite, no commit
    // An older build appending a union line it found missing lands ABOVE nothing of ours on the next pass:
    const olderBuildTouched = next + "owner_map.yaml merge=union\n";
    const healed = desiredGitattributes(olderBuildTouched);
    expect(healed.trimEnd().endsWith("# <<< Large File Bridge merge driver")).toBe(true);
  });
});

describe("the merge itself", () => {
  it("WITH the driver: a clean merge that parses, one entry per file, no fused items", () => {
    write(".gitattributes", desiredGitattributes("decisions.yaml merge=union\n"));
    git("config", "merge.lfb.driver", mergeDriverCommand());
    const { ok } = divergeAndMerge();
    expect(ok).toBe(true);
    const doc = YAML.parse(read("decisions.yaml")) as { events: { path: string; decided_at: string }[] };
    // Both re-stamps are events in their own right (the log keeps both); nothing was fused.
    expect(doc.events.every((e) => typeof e.path === "string" && typeof e.decided_at === "string")).toBe(true);
    expect(new Set(doc.events.map((e) => e.path))).toEqual(new Set(["img/a.jpg", "img/b.jpg"]));
  }, 60_000);

  it("WITHOUT the driver (an older computer): git falls back to a text merge — a conflict, never silent damage", () => {
    write(".gitattributes", desiredGitattributes("decisions.yaml merge=union\n"));
    const { ok } = divergeAndMerge();
    expect(ok).toBe(false);
    expect(read("decisions.yaml")).toMatch(/^<<<<<<< /m);
  }, 60_000);
});

describe("manifest.yaml: a three-way merge of the claims", () => {
  const manifest = (claims: string[], cid = "bafyA"): string =>
    YAML.stringify({ schema_version: 1, unit: "repo", files: [{ path: "v.mp4", cid, size: 1, sha256: null, pinned_by: claims }] });

  it("a claim WITHDRAWN on one side stays withdrawn; a claim ADDED on the other side is kept", () => {
    write(".gitattributes", desiredGitattributes("manifest.yaml merge=union\n"));
    git("config", "merge.lfb.driver", mergeDriverCommand());
    write("manifest.yaml", manifest(["laptop", "tower"]));
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "side");
    write("manifest.yaml", manifest(["laptop", "studio", "tower"])); // studio pinned it
    git("commit", "-qam", "side");
    git("checkout", "-q", "main");
    write("manifest.yaml", manifest(["tower"])); // laptop no longer holds it
    git("commit", "-qam", "main");
    git("merge", "--no-edit", "side");
    const files = (YAML.parse(read("manifest.yaml")) as { files: { pinned_by: string[] }[] }).files;
    expect(files).toHaveLength(1);
    expect(files[0]!.pinned_by).toEqual(["studio", "tower"]); // a line union would have kept "laptop"
  }, 60_000);
});

describe("driver registration is stable across processes", () => {
  it("keeps any registration that still runs our driver, rewrites a stale one", async () => {
    const { registrationStillWorks } = await import("../modules/git/git.service.js");
    expect(registrationStillWorks(mergeDriverCommand())).toBe(true);
    expect(registrationStillWorks(mergeDriverCommand().replace(process.execPath, "/no/such/node"))).toBe(false);
    expect(registrationStillWorks("'/usr/bin/true' %O %A %B %P")).toBe(false); // not our driver
  });
});
