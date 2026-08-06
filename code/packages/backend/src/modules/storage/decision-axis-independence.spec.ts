// Pins the defect that made "Pin now (selected)" a no-op on real files (2026-08-05, repo `all`).
//
// A decision has TWO independent axes and `DecisionAxes` documents an omitted one as "leave as-is" — but the
// write path stamped `ipfs: !!axes.ipfs`, so undefined became a recorded "no". The ⊘ git-ignore toggle
// carries only its own axis, so every click on an UNDECIDED file also recorded `ipfs:false`. Five training
// videos git-ignored one after another (jfk/training/videos/Sital/*, 06:12–06:15) were thereby decided
// "never add to IPFS": they left the Add-to-IPFS tile, which counts UNDECIDED files, and Pin now — which
// moves bytes for `sync`-decided files only — reported "Nothing to pin" over all five.
//
// The rule under test: carry an omitted axis forward from the prior decision; with NO prior decision there
// is nothing to carry and no answer the user gave, so the path records no event and stays Undecided.
import { describe, it, expect } from "vitest";
import { axesToRecord } from "./decisions.service.js";

const was = (ipfs: boolean, gitignore: boolean, asked = true) => ({ asked, ipfs, gitignore });

describe("axesToRecord — an omitted axis is 'leave as-is', never a decision of 'no'", () => {
  it("git-ignoring an UNDECIDED file records NOTHING — it must not decide the IPFS axis", () => {
    expect(axesToRecord({ gitignore: true }, true, undefined)).toBeNull();
  });

  it("git-ignoring a file already set to Add-to-IPFS keeps that decision", () => {
    expect(axesToRecord({ gitignore: true }, true, was(true, false))).toEqual({ ipfs: true, gitignore: true });
  });

  it("git-ignoring a file already decided NO keeps the no — carrying forward cuts both ways", () => {
    expect(axesToRecord({ gitignore: true }, true, was(false, false))).toEqual({ ipfs: false, gitignore: true });
  });

  it("un-ignoring never touches the IPFS axis either", () => {
    expect(axesToRecord({ gitignore: false }, true, was(true, true))).toEqual({ ipfs: true, gitignore: false });
  });

  it("a prior TOMBSTONE is not a prior decision — the file is Undecided, so there is nothing to carry", () => {
    expect(axesToRecord({ gitignore: true }, true, was(true, true, false))).toBeNull();
  });

  it("the pin toggle still decides its own axis with no prior state", () => {
    expect(axesToRecord({ ipfs: true }, true, undefined)).toEqual({ ipfs: true, gitignore: false });
  });

  it("an explicit both-off write is a real decision and is recorded (decisions.mdx §1)", () => {
    expect(axesToRecord({ ipfs: false, gitignore: false }, true, undefined)).toEqual({
      ipfs: false,
      gitignore: false,
    });
  });

  it("the pin toggle carries the git-ignore axis forward rather than clearing its provenance", () => {
    expect(axesToRecord({ ipfs: true }, true, was(false, true))).toEqual({ ipfs: true, gitignore: true });
  });

  it("a tombstone is always written — asked:false un-decides both axes on the fold", () => {
    expect(axesToRecord({}, false, undefined)).toEqual({ ipfs: false, gitignore: false });
    expect(axesToRecord({}, false, was(true, true))).toEqual({ ipfs: false, gitignore: false });
  });
});
