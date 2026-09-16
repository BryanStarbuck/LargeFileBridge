// "Will IPFS come back after I reboot?" has ONE answer, derived ONCE (ipfs_ui.mdx §13.3).
//
// The failure this guards: the answer was re-derived per UI surface, and the surfaces disagreed. The
// dashboard row credited Homebrew's kubo agent ("on ✓"); the app-wide banner read `autostart.enabled` —
// which is OUR agent only, and false by design when Homebrew owns the start (§13.2) — and said "won't
// restart after you reboot". Its Turn-on button ran an install that correctly refused to compete with
// Homebrew and changed nothing the banner could see. On this machine that button was pressed four times:
// four "success" toasts, banner still there. `resolveOwner` is now the only place the answer is made.
import { describe, it, expect } from "vitest";
import { resolveOwner } from "./ipfs-autostart.service.js";

const foreignThatRuns = { willRunAtLogin: true };
const foreignOnDiskOnly = { willRunAtLogin: false };

describe("resolveOwner — the single derivation of who brings IPFS back after a reboot", () => {
  it("credits a foreign agent launchd will actually run, even with no LFB agent at all (the Homebrew machine)", () => {
    expect(resolveOwner({ enabled: false, lastRunFailed: false, conflict: foreignThatRuns })).toBe("foreign");
  });

  it("credits the foreign agent over an installed LFB agent — ours is the one losing the repo-lock race", () => {
    expect(resolveOwner({ enabled: true, lastRunFailed: true, conflict: foreignThatRuns })).toBe("foreign");
    expect(resolveOwner({ enabled: true, lastRunFailed: false, conflict: foreignThatRuns })).toBe("foreign");
  });

  it("credits our agent when it is registered, not disabled, and not dead", () => {
    expect(resolveOwner({ enabled: true, lastRunFailed: false, conflict: null })).toBe("lfb");
  });

  it("answers nobody for a registered-but-dead LFB agent (§13.1: registered is not working)", () => {
    expect(resolveOwner({ enabled: true, lastRunFailed: true, conflict: null })).toBeNull();
  });

  it("answers nobody for a foreign plist merely sitting on disk — disabled or never bootstrapped starts nothing", () => {
    expect(resolveOwner({ enabled: false, lastRunFailed: false, conflict: foreignOnDiskOnly })).toBeNull();
    // ...and falls through to OUR agent when we have a working one alongside it.
    expect(resolveOwner({ enabled: true, lastRunFailed: false, conflict: foreignOnDiskOnly })).toBe("lfb");
  });

  it("answers nobody when nothing is installed", () => {
    expect(resolveOwner({ enabled: false, lastRunFailed: false, conflict: null })).toBeNull();
  });
});
