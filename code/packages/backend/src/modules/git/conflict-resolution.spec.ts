// The conflict-resolution ladder that keeps a company tracking repo syncing by itself
// (storage_company.mdx §11.1).
//
// The defect these tests pin down: LFB used to auto-resolve exactly ONE filename (`repo_storage.yaml`), and
// only when EVERY conflicted path in the merge was that filename. Anything else aborted the merge, and
// `commitAndPush` then refused to run — so a single conflicted sidecar froze the storage's entire backbone
// until a human ran git by hand. Since the mirrored `repos/<repoUid>/` payload now rides in every company
// repo, that was the common case. Every path LFB owns must have a rule.
import { describe, it, expect } from "vitest";
import { resolutionFor } from "./git.service.js";

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
