// subsets.csv + subset_run.yaml round-trip (subsets.mdx §9). Same isolation rule as dedupe-store.spec:
// a per-test temp LFB_STATE_DIR — the real state root is never touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.LFB_STATE_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-subset-store-"));
  process.env.LFB_STATE_DIR = tmpDir;
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.LFB_STATE_DIR;
  else process.env.LFB_STATE_DIR = savedStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("subset-store", () => {
  it("round-trips superset + subset rows through subsets.csv", async () => {
    const store = await import("./subset-store.js");
    const rows = [
      {
        group: "a71f30d2",
        fullPath: "/Users/x/Movies/trees_full.mov",
        role: "superset" as const,
        sha256: "3c".repeat(32),
        fingerprint: "signatures/" + "3c".repeat(32) + ".mpeg7sig",
        matchBasis: "mpeg7" as const,
        startOffsetS: null, // superset row — empty offsets (§9)
        endOffsetS: null,
        confidence: 0.97,
        sizeBytes: 2040109466,
        durationS: 604,
        width: 1920,
        height: 1080,
        codec: "h264",
        detectedAt: "2026-07-22T10:02:11Z",
      },
      {
        group: "a71f30d2",
        fullPath: "/Users/x/Movies/clips, cuts/trees \"clip\".mp4",
        role: "subset" as const,
        sha256: "77".repeat(32),
        fingerprint: "signatures/" + "77".repeat(32) + ".mpeg7sig",
        matchBasis: "vpdq" as const,
        startOffsetS: 190,
        endOffsetS: 372,
        confidence: 0.8,
        sizeBytes: 432013312,
        durationS: 182,
        width: 1280,
        height: 720,
        codec: "hevc",
        detectedAt: "2026-07-22T10:02:11Z",
      },
    ];
    store.writeSubsetsCsv(rows);

    const file = path.join(tmpDir, "videos", "subsets.csv");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8").split("\n")[0]).toBe(
      "subset_group,full_path,role,sha256,fingerprint,match_basis,start_offset_s,end_offset_s,confidence,size_bytes,duration_s,width,height,codec,detected_at",
    );

    expect(store.readSubsetsCsv()).toEqual(rows);
  });

  it("reads an absent CSV as empty and skips rows with a bad role or basis", async () => {
    const store = await import("./subset-store.js");
    expect(store.readSubsetsCsv()).toEqual([]);
    const dir = path.join(tmpDir, "videos");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "subsets.csv"),
      "subset_group,full_path,role,sha256,fingerprint,match_basis,start_offset_s,end_offset_s,confidence,size_bytes,duration_s,width,height,codec,detected_at\n" +
        "g,/a.mp4,NOT_A_ROLE,s,f,mpeg7,,,0.9,1,10,,,h264,2026-01-01T00:00:00Z\n" +
        "g,/a.mp4,subset,s,f,NOT_A_BASIS,,,0.9,1,10,,,h264,2026-01-01T00:00:00Z\n" +
        "g,/a.mp4,subset,s,f,mpeg7,1.5,3,0.9,1,10,,,h264,2026-01-01T00:00:00Z\n",
    );
    const rows = store.readSubsetsCsv();
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("subset");
    expect(rows[0].startOffsetS).toBe(1.5);
    expect(rows[0].width).toBeNull();
  });

  it("keeps its run stamp separate from the duplicate scan's (independent staleness clocks)", async () => {
    const subsetStore = await import("./subset-store.js");
    const dedupeStore = await import("./dedupe-store.js");
    subsetStore.writeSubsetRunStamp({
      lastRunAt: "2026-07-20T00:00:00Z",
      ok: true,
      complete: true,
      counts: {},
      durationMs: 1,
    });
    expect(subsetStore.readSubsetRunStamp()?.lastRunAt).toBe("2026-07-20T00:00:00Z");
    // Writing the subset stamp must NOT create/satisfy the dedupe stamp (videos.mdx §4).
    expect(dedupeStore.readDedupeRunStamp()).toBeNull();
  });
});
