// duplicates.csv + dedupe_run.yaml round-trip (duplicates.mdx §9). CRITICAL ISOLATION RULE: every write
// goes to a per-test temp LFB_STATE_DIR — never the real ~/T/_large_files_bridge (the vitest baseline
// already redirects, but these tests own their dir so parallel specs can't cross-read each other's CSV).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.LFB_STATE_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-dedupe-store-"));
  process.env.LFB_STATE_DIR = tmpDir;
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.LFB_STATE_DIR;
  else process.env.LFB_STATE_DIR = savedStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("dedupe-store", () => {
  it("round-trips rows through duplicates.csv, including hostile paths", async () => {
    const store = await import("./dedupe-store.js");
    const rows = [
      {
        group: "4f2a91c8",
        fullPath: "/Users/x/Movies/trees.mov",
        sha256: "a".repeat(64),
        fingerprint: "vpdq/" + "a".repeat(64) + ".vpdq",
        matchBasis: "fingerprint" as const,
        sizeBytes: 734003200,
        durationS: 93.4,
        width: 1920,
        height: 1080,
        codec: "prores",
        detectedAt: "2026-07-22T09:14:02Z",
      },
      {
        group: "4f2a91c8",
        // Commas, quotes AND a newline in the path — the CSV must quote/escape and parse back exactly.
        fullPath: '/Users/x/My, "weird"\npath/trees copy.mov',
        sha256: "b".repeat(64),
        fingerprint: "",
        matchBasis: "fingerprint" as const,
        sizeBytes: 118489088,
        durationS: null,
        width: null,
        height: null,
        codec: null,
        detectedAt: "2026-07-22T09:14:02Z",
      },
      {
        group: "9c81aa00",
        fullPath: "/Users/x/img.png",
        sha256: "c".repeat(64),
        fingerprint: "f".repeat(64),
        matchBasis: "sha256" as const,
        sizeBytes: 1024,
        durationS: null,
        width: 640,
        height: 480,
        codec: "png",
        detectedAt: "2026-07-22T09:14:02Z",
      },
    ];
    store.writeDuplicatesCsv(rows);

    // On disk: inside the temp state root, in videos/duplicates.csv — never the real state root.
    const file = path.join(tmpDir, "videos", "duplicates.csv");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8").split("\n")[0]).toBe(
      "duplicate_group,full_path,sha256,fingerprint,match_basis,size_bytes,duration_s,width,height,codec,detected_at",
    );

    const back = store.readDuplicatesCsv();
    expect(back).toEqual(rows);
  });

  it("reads an absent CSV as empty and skips malformed rows", async () => {
    const store = await import("./dedupe-store.js");
    expect(store.readDuplicatesCsv()).toEqual([]);
    const file = path.join(tmpDir, "videos");
    fs.mkdirSync(file, { recursive: true });
    fs.writeFileSync(
      path.join(file, "duplicates.csv"),
      "duplicate_group,full_path,sha256,fingerprint,match_basis,size_bytes,duration_s,width,height,codec,detected_at\n" +
        "garbage line\n" + // too few fields → skipped
        "g1,/a/b.mov,x,y,BAD_BASIS,1,,,,,2026-01-01T00:00:00Z\n" + // bad enum → skipped
        "g1,/a/b.mov,x,y,sha256,1,,,,,2026-01-01T00:00:00Z\n",
    );
    const rows = store.readDuplicatesCsv();
    expect(rows).toHaveLength(1);
    expect(rows[0].matchBasis).toBe("sha256");
    expect(rows[0].durationS).toBeNull();
  });

  it("round-trips the run stamp and drives staleness from it", async () => {
    const store = await import("./dedupe-store.js");
    expect(store.readDedupeRunStamp()).toBeNull();
    store.writeDedupeRunStamp({
      lastRunAt: "2026-07-22T09:14:02.000Z",
      ok: true,
      counts: { candidates: 12, groups: 3, files: 7 },
      durationMs: 4200,
    });
    const stamp = store.readDedupeRunStamp();
    expect(stamp).not.toBeNull();
    expect(stamp!.lastRunAt).toBe("2026-07-22T09:14:02.000Z");
    expect(stamp!.ok).toBe(true);
    expect(stamp!.counts.groups).toBe(3);
    expect(stamp!.durationMs).toBe(4200);
  });
});
