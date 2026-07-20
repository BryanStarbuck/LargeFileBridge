// The SDL payload guard must cover the COMPANY storage's shape, not only the personal one.
//
// `ensureSdlCommittable` strips any `.gitignore` rule that would swallow a dedicated file repo's travelling
// text (git_backbone.mdx §4.2.1) — otherwise the device registry and the tracking state never reach the
// user's other computers, silently. The set it checks was written from the PERSONAL SDL's root shape and
// stopped there, so the two names that carry a COMPANY storage's content were missing:
//
//   • `repos/` — the mirrored `repos/<repoUid>/` tracking subtrees. On the reference machine this is the
//     entire payload of `act3_large_files_bridge` (its root holds only `repos/`, `devices/`, `manifest.yaml`,
//     `storage.yaml`, `README.md`), while `personal_large_files_bridge` has no `repos/` at all. So an
//     unprotected `repos/` line is a company-only outage — and the personal storage keeps working, which is
//     exactly the shape that makes it read as "company sync is broken" rather than as a gitignore rule.
//   • `owner_map.yaml` — the travelling company-ownership assertion (repo_owner_propagation.mdx §2), which
//     exists only in a company SDL.
import { describe, it, expect } from "vitest";
import { ignoresSdlPayloadLine } from "./git.service.js";

describe("ignoresSdlPayloadLine — company payload is protected like personal payload", () => {
  it.each([
    "repos",
    "repos/",
    "/repos",
    "/repos/",
    "owner_map.yaml",
    "/owner_map.yaml",
  ])("catches the company-side rule %j", (line) => {
    expect(ignoresSdlPayloadLine(line)).toBe(true);
  });

  it.each([
    "devices",
    "analysis",
    "storage.yaml",
    "manifest.yaml",
    "mapped_dirs.yaml",
    "files.yaml",
    "bookmarks.yaml",
    "decisions.yaml",
    ".lfbridge/",
  ])("still catches the personal/legacy rule %j", (line) => {
    expect(ignoresSdlPayloadLine(line)).toBe(true);
  });

  it.each(["", "   ", "# repos", "!repos", ".DS_Store", "*.mp4", "node_modules/"])(
    "leaves the unrelated rule %j alone",
    (line) => {
      expect(ignoresSdlPayloadLine(line)).toBe(false);
    },
  );

  it("does not match a NESTED path that merely starts with a payload name", () => {
    // The guard is for root-level rules. `repos/83e/manifest.yaml` is a specific file the user may
    // legitimately ignore; only the blanket `repos` rule severs the payload.
    expect(ignoresSdlPayloadLine("repos/83e62afc2c80/manifest.yaml")).toBe(false);
  });
});
