// The Videos review tables' row model (duplicates.mdx §3.1/§3.2, subsets.mdx §3).
//
// The rule these tests exist to protect: the table shows ONE ROW PER GROUP, labelled with a
// REPRESENTATIVE member's file name. It used to interleave a header row with one row per member, so a
// 9-file group ate 10 rows; the per-file detail lives in the right review column now.
import { describe, it, expect } from "vitest";
import type { DuplicateMemberRow, SubsetMemberRow } from "@lfb/shared";
import { buildDuplicateGroups, buildSubsetGroups, buildVideoColumns } from "./videoGroups.js";

const base = {
  durationS: 10,
  width: 1920,
  height: 1080,
  codec: "h264",
  fingerprint: "",
  decision: null,
  gitIgnored: false,
  hasTranscription: false,
  hasDescription: false,
  hasOcr: false,
  detectedAt: "2026-07-22T00:00:00Z",
};

const dup = (group: string, name: string, sizeBytes: number): DuplicateMemberRow => ({
  ...base,
  group,
  matchBasis: "sha256",
  fullPath: `/Users/x/Movies/${name}`,
  name,
  sizeBytes,
  sha256: `sha-${group}`,
});

const sub = (
  group: string,
  name: string,
  role: "superset" | "subset",
  sizeBytes: number,
  startOffsetS: number | null,
): SubsetMemberRow => ({
  ...base,
  group,
  matchBasis: "mpeg7",
  fullPath: `/Users/x/Movies/${name}`,
  name,
  sizeBytes,
  sha256: `sha-${name}`,
  role,
  startOffsetS,
  endOffsetS: startOffsetS == null ? null : startOffsetS + 30,
  confidence: 0.9,
});

describe("buildDuplicateGroups", () => {
  it("collapses each group to ONE row and labels it with a member's file name", () => {
    const groups = buildDuplicateGroups([
      dup("g1", "trees.mov", 300),
      dup("g1", "trees_copy.mov", 300),
      dup("g1", "trees_old.mov", 300),
    ]);
    expect(groups).toHaveLength(1); // one group, one row — not 1 header + 3 members
    expect(groups[0].members).toHaveLength(3);
    expect(groups[0].representativeName).toBe("trees.mov");
    // Reclaimable = total minus the one copy worth keeping.
    expect(groups[0].reclaimableBytes).toBe(600);
  });

  it("orders groups by reclaimable bytes descending — the most disk-winning first (§3.2)", () => {
    const groups = buildDuplicateGroups([
      dup("small", "a.mp4", 100),
      dup("small", "b.mp4", 100),
      dup("big", "c.mp4", 5000),
      dup("big", "d.mp4", 5000),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["big", "small"]);
  });

  it("keeps EVERY member's name and path searchable from the group's single row", () => {
    // The row shows one name, so search must still reach the others — otherwise typing the name of the
    // duplicate you are hunting for silently finds nothing.
    const [g] = buildDuplicateGroups([dup("g1", "trees.mov", 1), dup("g1", "beach_holiday.mp4", 1)]);
    expect(g.searchText).toContain("beach_holiday.mp4");
    expect(g.searchText).toContain("/Users/x/Movies/beach_holiday.mp4");
  });
});

describe("buildSubsetGroups", () => {
  it("names the group for its SUPERSET and orders members superset-first, then by containment start", () => {
    const [g] = buildSubsetGroups([
      sub("g1", "clip_late.mov", "subset", 50, 400),
      sub("g1", "clip_early.mov", "subset", 50, 30),
      sub("g1", "full_movie.mov", "superset", 900, null),
    ]);
    expect(g.representativeName).toBe("full_movie.mov");
    expect(g.members.map((m) => m.name)).toEqual(["full_movie.mov", "clip_early.mov", "clip_late.mov"]);
    // Reclaimable = what deleting the CLIPS would free — never the superset (subsets.mdx §3).
    expect(g.reclaimableBytes).toBe(100);
  });
});

describe("buildVideoColumns", () => {
  it("is the deliberately small group column set — File, Files, Size, and nothing else (§3.1)", () => {
    const ids = buildVideoColumns().map((c) => c.id);
    expect(ids).toEqual(["file", "count", "size"]);
    // The five icon control columns moved to the right review column with the files themselves (§4.3).
    expect(ids).not.toContain("pin");
    expect(ids).not.toContain("ocr");
  });
});
