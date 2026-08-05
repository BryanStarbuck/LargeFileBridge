// The conflict-resolution ladder that keeps a company tracking repo syncing by itself
// (storage_company.mdx §11.1).
//
// The defect these tests pin down: LFB used to auto-resolve exactly ONE filename (`repo_storage.yaml`), and
// only when EVERY conflicted path in the merge was that filename. Anything else aborted the merge, and
// `commitAndPush` then refused to run — so a single conflicted sidecar froze the storage's entire backbone
// until a human ran git by hand. Since the mirrored `repos/<repoUid>/` payload now rides in every company
// repo, that was the common case. Every path LFB owns must have a rule.
import { describe, it, expect } from "vitest";
import YAML from "yaml";
import { resolutionFor, unionConflictedText } from "./git.service.js";

describe("resolutionFor — every file LFB owns has an automatic resolution (§11.1)", () => {
  it("regenerates machine-generated caches rather than picking a side", () => {
    // Neither side of a cache is worth keeping: Local Storage is authoritative and rebuilds it next pass.
    expect(resolutionFor("repos/83e62afc2c80/repo_storage.yaml")).toBe("regenerate");
    expect(resolutionFor(".lfbridge/repo_storage.yaml")).toBe("regenerate"); // legacy shape
    expect(resolutionFor("files.yaml")).toBe("regenerate");
    expect(resolutionFor("repos/83e62afc2c80/files.yaml")).toBe("regenerate");
  });

  it("keeps our own copy of a self-owned device file", () => {
    expect(resolutionFor("devices/bryan-mac-pro.yaml")).toBe("ours");
    expect(resolutionFor("devices/bryanstarbuck-macbook-pro.yaml")).toBe("ours");
  });

  it("keeps our own copy of a self-owned DEBUG EXPORT", () => {
    // This path had no rule, and the consequence was the whole point of this file: an add/add conflict on
    // one debug export aborted the ENTIRE merge on the company tracking repo every cycle, so that storage
    // stopped syncing while the log repeated "1 conflicted path(s) have no automatic resolution".
    // Observed live on 2026-07-29.
    expect(resolutionFor("debug/bryan-mac-pro/debug.yaml")).toBe("ours");
    expect(resolutionFor("debug/bryanstarbuck-macbook-pro/debug.yaml")).toBe("ours");
    expect(resolutionFor(".lfbridge/debug/bryan-mac-pro/debug.yaml")).toBe("ours");
  });

  it("unions the append-only lists — at the root AND inside the mirrored per-repo subtree", () => {
    // These are exactly the paths that used to abort a company repo's whole cycle.
    for (const p of [
      "manifest.yaml",
      "decisions.yaml",
      "owner_map.yaml",
      "LargeFilesBridge_SyncList.yaml",
      "repos/83e62afc2c80/manifest.yaml",
      "repos/83e62afc2c80/decisions.yaml",
      "repos/83e62afc2c80/files/videos/clip.mp4.yaml",
      "repos/83e62afc2c80/history/bryan-mac-pro.txt",
    ]) {
      expect(resolutionFor(p), p).toBe("union");
    }
  });

  it("returns null for a file it does not own, so it is quarantined rather than guessed at", () => {
    // No rule must NEVER mean "pick something" — it means quarantine this one file and keep the rest moving.
    expect(resolutionFor("README.md")).toBeNull();
    expect(resolutionFor("some/user/file.txt")).toBeNull();
  });

  it("never lets one unhandled path decide another's fate", () => {
    // The old code keyed the decision on the WHOLE merge; the ladder is per path, so a mixed merge resolves
    // the files it can and only escalates the ones it genuinely cannot.
    const mixed = ["repos/abc123def456/repo_storage.yaml", "README.md"];
    const verdicts = mixed.map(resolutionFor);
    expect(verdicts).toEqual(["regenerate", null]);
  });
});

// The "union" rung, applied to a STRUCTURED file. The hand-rolled union deduped identical lines across the
// WHOLE file — correct for a flat log, catastrophic for YAML, where `sha256: null` and `pinned_by:` repeat
// once per entry. Every entry after the first would have lost those keys and the file would stop parsing.
describe("unionConflictedText — a union must never delete a line from a structured file", () => {
  const conflicted = [
    "schema_version: 1",
    "unit: repo",
    "files:",
    "<<<<<<< HEAD",
    "  - path: a.mp4",
    "    cid: bafyA",
    "    sha256: null",
    "    pinned_by:",
    "      - bryan-mac-pro",
    "=======",
    "  - path: b.mp4",
    "    cid: bafyB",
    "    sha256: null",
    "    pinned_by:",
    "      - bryan-mac-pro",
    ">>>>>>> origin/main",
    "",
  ].join("\n");

  it("keeps BOTH entries intact, including their repeated keys", () => {
    const out = unionConflictedText("repos/eb94a756b52e/manifest.yaml", conflicted);
    expect(out).not.toMatch(/^[<>=|]{7}/m); // markers gone
    expect(out.match(/sha256: null/g)).toHaveLength(2); // the repeated key survived
    expect(out.match(/pinned_by:/g)).toHaveLength(2);
    expect(out.match(/ {6}- bryan-mac-pro/g)).toHaveLength(2); // the repeated device claim survived
  });

  it("produces YAML that still parses, with both sides' entries present", () => {
    const doc = YAML.parse(unionConflictedText("manifest.yaml", conflicted)) as {
      files: Array<{ path: string; cid: string; pinned_by: string[] }>;
    };
    expect(doc.files.map((f) => f.path)).toEqual(["a.mp4", "b.mp4"]);
    expect(doc.files.every((f) => f.pinned_by.includes("bryan-mac-pro"))).toBe(true);
  });

  it("still dedupes a FLAT log, so a repeated merge cannot grow history/<device>.txt without bound", () => {
    const log = ["2026-08-05 pulled a.mp4", "<<<<<<< HEAD", "2026-08-05 pulled a.mp4", "=======", "2026-08-05 pulled b.mp4", ">>>>>>> origin/main"].join("\n");
    const out = unionConflictedText("repos/eb94a756b52e/history/bryan-mac-pro.txt", log);
    expect(out.match(/pulled a\.mp4/g)).toHaveLength(1);
    expect(out).toContain("pulled b.mp4");
  });
});
