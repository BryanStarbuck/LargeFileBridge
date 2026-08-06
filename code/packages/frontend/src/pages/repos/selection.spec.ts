// Checking a few rows and choosing "Pin now" pinned the WHOLE repo, and the bulk menu's own "Pin now
// (selected)" pinned nothing at all — two halves of the same defect. The checked set holds `fileId`
// (`<repoId>:<relPath>`), and the bulk menu shipped those straight to endpoints that speak paths, so
// `onlyPaths.has(rel)` matched nothing on the server and the run reported "nothing to pin". These tests
// lock the mapping so no call site can go back to passing fileIds.
import { describe, it, expect } from "vitest";
import type { FileRow } from "@lfb/shared";
import { selectedRows, selectedRelPaths, selectedAbsPaths, partitionForPin } from "./selection.js";

const REPO_ID = "r7f3";
const REPO_PATH = "/home/me/code/movies";

function row(rel: string): FileRow {
  return {
    fileId: `${REPO_ID}:${rel}`,
    path: rel,
    sizeBytes: 1024,
    cid: null,
    decision: "undecided",
    transfer: "pending",
    peers: [],
    changedAt: "2026-08-01T00:00:00.000Z",
  };
}

const FILES = [row("intro.mp4"), row("b-roll/city.mov"), row("outro.mp4")];
const checked = (...rels: string[]) => new Set(rels.map((r) => `${REPO_ID}:${r}`));

describe("one-repo selection → paths", () => {
  it("maps fileIds to REPO-RELATIVE paths — never the fileId itself", () => {
    const paths = selectedRelPaths(FILES, checked("intro.mp4", "b-roll/city.mov"));
    expect(paths).toEqual(["intro.mp4", "b-roll/city.mov"]);
    expect(paths.some((p) => p.includes(REPO_ID))).toBe(false);
  });

  it("maps fileIds to ABSOLUTE paths under the repo root", () => {
    expect(selectedAbsPaths(FILES, checked("outro.mp4"), REPO_PATH)).toEqual([`${REPO_PATH}/outro.mp4`]);
  });

  it("returns only the checked rows, in table order", () => {
    expect(selectedRows(FILES, checked("outro.mp4", "intro.mp4")).map((f) => f.path)).toEqual([
      "intro.mp4",
      "outro.mp4",
    ]);
  });

  it("is EMPTY when nothing is checked — the caller's cue to fall back to whole-repo scope", () => {
    // "Pin now" reads this: empty ⇒ send `undefined` (pin the repo); non-empty ⇒ pin exactly these. The bug
    // was skipping the question entirely and always sending `undefined`.
    expect(selectedRelPaths(FILES, new Set())).toEqual([]);
    expect(selectedAbsPaths(FILES, new Set(), REPO_PATH)).toEqual([]);
  });

  it("drops a checked row that no longer exists in the data", () => {
    expect(selectedRelPaths(FILES, checked("intro.mp4", "deleted-since.mp4"))).toEqual(["intro.mp4"]);
  });

  it("yields nothing for absolute paths before the repo path has loaded", () => {
    expect(selectedAbsPaths(FILES, checked("intro.mp4"), undefined)).toEqual([]);
  });
});

// The other half of the same defect: the mapping was right, but a pin pass moves bytes ONLY for files
// decided Add-to-IPFS, so "Pin now (5)" over five undecided rows found nothing eligible and toasted a green
// "Nothing to pin" — while its own label had just promised to pin those five. Clicking a row's pin icon
// looked like it worked only because that path DECIDES the file first. These tests lock the split the
// action reads before it offers to decide the rest.
describe("partitionForPin — what a checked row means to a pin run", () => {
  const decided = (rel: string, over: Partial<FileRow> = {}): FileRow => ({ ...row(rel), ...over });

  it("splits ready / needs-a-decision / Never-IPFS", () => {
    const p = partitionForPin([
      decided("a.mp4", { decision: "sync" }),
      decided("b.mp4", { decision: "undecided" }),
      decided("c.mp4", { decision: "ignore" }),
      decided("d.mp4", { decision: "undecided", neverIpfs: true }),
    ]);
    expect(p).toEqual({ ready: ["a.mp4"], needsDecision: ["b.mp4", "c.mp4"], blocked: ["d.mp4"] });
  });

  it("counts an IGNORE-decided row as needing a decision, not as blocked", () => {
    // The exact shape of the reported bug: git-ignoring a file recorded ipfs:false, so five undecided rows
    // read as "ignore" and a pin over them was a silent no-op. They are re-offerable, not refused.
    const p = partitionForPin([decided("clip.mp4", { decision: "ignore" })]);
    expect(p.needsDecision).toEqual(["clip.mp4"]);
    expect(p.blocked).toEqual([]);
  });

  it("never offers a Never-IPFS row — the write path refuses it (decisions.mdx §17)", () => {
    const p = partitionForPin([decided("secret.mov", { decision: "undecided", neverIpfs: true })]);
    expect(p.needsDecision).toEqual([]);
    expect(p.blocked).toEqual(["secret.mov"]);
  });

  it("leaves an ALREADY-decided Never-IPFS row pinnable — the flag gates new decisions, not existing pins", () => {
    const p = partitionForPin([decided("legacy.mp4", { decision: "sync", neverIpfs: true })]);
    expect(p.ready).toEqual(["legacy.mp4"]);
  });
});
