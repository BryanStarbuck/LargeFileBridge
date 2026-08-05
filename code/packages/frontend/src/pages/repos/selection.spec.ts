// Checking a few rows and choosing "Pin now" pinned the WHOLE repo, and the bulk menu's own "Pin now
// (selected)" pinned nothing at all — two halves of the same defect. The checked set holds `fileId`
// (`<repoId>:<relPath>`), and the bulk menu shipped those straight to endpoints that speak paths, so
// `onlyPaths.has(rel)` matched nothing on the server and the run reported "nothing to pin". These tests
// lock the mapping so no call site can go back to passing fileIds.
import { describe, it, expect } from "vitest";
import type { FileRow } from "@lfb/shared";
import { selectedRows, selectedRelPaths, selectedAbsPaths } from "./selection.js";

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
