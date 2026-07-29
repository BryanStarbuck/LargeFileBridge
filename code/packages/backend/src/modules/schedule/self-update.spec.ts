// SELF-UPDATE — a fix that is not running is not a fix (git_backbone.mdx §6.7).
//
// The incident: on 2026-07-29 two churn defects were found, fixed, committed and pushed while the flood
// continued at exactly its old rate. The computer doing the flooding was on an OLDER BUILD — its device
// file was missing fields the current schema publishes (the tell), and it kept emitting a timestamp-only
// commit every ~16 minutes. Nothing in the product could see the gap; it took reading two device files
// side by side by hand. These tests cover the machinery that now answers that question by itself.
import { describe, it, expect, beforeEach } from "vitest";
import { APP_BUILD } from "@lfb/shared";
import {
  stalePeers,
  stalePeerMessage,
  sourceRepoRoot,
  buildState,
  runningStaleCode,
  shouldReportStalePeers,
  type StalePeer as StalePeerT,
} from "./self-update.service.js";

describe("stalePeers — which of the user's computers are behind this one", () => {
  const OURS = 4;

  it("finds a peer on an older build", () => {
    const out = stalePeers(
      [
        { name: "bryan-mac-pro", build: 4 },
        { name: "bryanstarbuck-macbook-pro", build: 3 },
      ],
      "bryan-mac-pro",
      OURS,
    );
    expect(out).toEqual([{ device: "bryanstarbuck-macbook-pro", build: 3, label: "" }]);
  });

  it("treats a peer with NO build number as the stalest of all", () => {
    // A build too old to publish the field at all reports 0 — which is itself the answer, and exactly the
    // shape of the computer that caused the incident.
    const out = stalePeers([{ name: "old-laptop", build: 0 }], "tower", OURS);
    expect(out).toHaveLength(1);
    expect(out[0]!.build).toBe(0);
  });

  it("never reports THIS computer, however it compares", () => {
    // Self is not a peer. Nagging the user about the machine they are looking at is noise, not a finding.
    expect(stalePeers([{ name: "tower", build: 1 }], "tower", OURS)).toEqual([]);
  });

  it("stays silent when the whole fleet is current, or ahead", () => {
    // A peer AHEAD of us is not our problem to report — that computer will update us, not the reverse.
    expect(stalePeers([{ name: "a", build: 4 }, { name: "b", build: 9 }], "tower", OURS)).toEqual([]);
  });

  it("orders the stalest first", () => {
    const out = stalePeers([{ name: "a", build: 3 }, { name: "b", build: 1 }], "tower", OURS);
    expect(out.map((p) => p.device)).toEqual(["b", "a"]);
  });
});

describe("stalePeerMessage — a sentence the user can act on", () => {
  it("names the computer, the build, and what to do", () => {
    const msg = stalePeerMessage([{ device: "bryanstarbuck-macbook-pro", build: 3, label: "" }]);
    // "Something is out of date" is not actionable. WHICH computer is the entire content.
    expect(msg).toContain("bryanstarbuck-macbook-pro");
    expect(msg).toContain("build 3");
    expect(msg).toContain(`build ${APP_BUILD.number}`);
    expect(msg).toMatch(/update Large File Bridge/i);
  });

  it("spells the product name out in full, per the charter", () => {
    const msg = stalePeerMessage([{ device: "x", build: 0, label: "" }])!;
    expect(msg).toContain("Large File Bridge");
    expect(msg).not.toMatch(/\bLFB\b|\bLFBridge\b/);
  });

  it("says nothing when there is nothing to say", () => {
    expect(stalePeerMessage([])).toBeNull();
  });
});

describe("shouldReportStalePeers — do not become the noise you are fixing", () => {
  // The watchdog ticks every 5 minutes. Unthrottled, this report would write ~288 WARN lines a day into
  // error.err about a condition that changes maybe twice a week, burying every other fault in the file.
  // Repeating a standing fact is not reporting it.
  const P = (name: string, build: number): StalePeerT => ({ device: name, build, label: "" });
  const T0 = 1_000_000_000_000;

  // The throttle keeps module-level state (it has to — it is remembering what it already said). Clear it
  // between tests through the public API: an empty set means "the fleet is current", which resets it.
  beforeEach(() => void shouldReportStalePeers([], T0 - 1));

  it("says it once, then stays quiet about the same answer", () => {
    expect(shouldReportStalePeers([P("laptop", 3)], T0)).toBe(true);
    expect(shouldReportStalePeers([P("laptop", 3)], T0 + 5 * 60_000)).toBe(false);
    expect(shouldReportStalePeers([P("laptop", 3)], T0 + 30 * 60_000)).toBe(false);
  });

  it("speaks again when the ANSWER changes", () => {
    expect(shouldReportStalePeers([P("laptop", 3)], T0)).toBe(true);
    // A second computer fell behind — genuinely new information, not a repeat.
    expect(shouldReportStalePeers([P("laptop", 3), P("pc", 2)], T0 + 60_000)).toBe(true);
  });

  it("repeats hourly as a reminder that it is still true", () => {
    expect(shouldReportStalePeers([P("laptop", 3)], T0)).toBe(true);
    expect(shouldReportStalePeers([P("laptop", 3)], T0 + 61 * 60_000)).toBe(true);
  });

  it("goes silent when the fleet catches up, and treats the NEXT problem as fresh news", () => {
    expect(shouldReportStalePeers([P("laptop", 3)], T0)).toBe(true);
    expect(shouldReportStalePeers([], T0 + 60_000)).toBe(false); // nothing to say
    // Same peer falls behind again minutes later: it must NOT be suppressed as a repeat.
    expect(shouldReportStalePeers([P("laptop", 3)], T0 + 120_000)).toBe(true);
  });
});

describe("the local build check", () => {
  it("locates its own source checkout", () => {
    // The path is derived from this module's location, never from cwd — the background worker and the web
    // app are launched from different directories.
    const root = sourceRepoRoot();
    expect(root).toBeTruthy();
    expect(root).toMatch(/LargeFileBridge/);
  });

  it("reports the published build number and a live git sha", () => {
    const st = buildState();
    expect(st.build).toBe(APP_BUILD.number);
    expect(st.currentSha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("does not call a freshly-booted process stale", () => {
    // bootedSha is captured on first read, so the first observation must never accuse itself.
    expect(runningStaleCode(buildState())).toBe(false);
  });

  it("DOES call it stale once the checkout moves past the running build", () => {
    const st = buildState();
    expect(runningStaleCode({ ...st, bootedSha: "aaaaaaa", currentSha: "bbbbbbb" })).toBe(true);
  });

  it("never claims staleness it cannot prove", () => {
    // No git, no answer. A missing sha must read as "unknown", never as "stale" — a false alarm here sends
    // the user chasing an upgrade that does not exist.
    const st = buildState();
    expect(runningStaleCode({ ...st, bootedSha: null, currentSha: "bbbbbbb" })).toBe(false);
    expect(runningStaleCode({ ...st, bootedSha: "aaaaaaa", currentSha: null })).toBe(false);
  });
});
