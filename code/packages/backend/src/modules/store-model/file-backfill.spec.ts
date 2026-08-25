// SLICE 5 — the two things about the file plane that are silent when they are wrong.
//
// 1. `fileFacets` is what every `lfb.file` row's derived columns come from, and every one of its outputs
//    is a column an index sorts or filters on. A wrong `media` hides a video from the Describe tab; a wrong
//    `dir_posix` mis-files a row in every directory rollup; a wrong `relPosix` splits one file into two
//    primary keys. None of those raise an error — they just quietly show the user the wrong table.
//
// 2. The empty-path candidate is a case the real corpus cannot produce (measured: 0 of 30,732 candidate
//    paths on this machine are blank), and it is the one input that can take down 999 innocent rows with
//    it — `file_rel_path_nonblank` is a CHECK, and a CHECK failure aborts the whole multi-row INSERT, not
//    the offending tuple. So the branch that rejects it is built by hand, the same way area 2's legacy
//    marker is.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, it, expect } from "vitest";
import { UnitStatusSchema } from "@lfb/shared";
import { BACKFILL_CANDIDATES, candidateRows } from "./file-backfill.js";
import { fileFacets } from "./file.repo.js";
import { copyRows, exec, q } from "../../shared/persistence/db.js";

describe("fileFacets — the derived columns every file index sorts and filters on", () => {
  it("splits a nested path into base_name / dir_posix / file_ext", () => {
    const f = fileFacets("videos/2024/clip.MP4");
    expect(f.baseName).toBe("clip.MP4");
    expect(f.dirPosix).toBe("videos/2024");
    // Lower-cased, dot included — `fileExt`'s contract, so the File-type facet's `.mp4` matches whatever
    // case the filesystem happens to carry.
    expect(f.fileExt).toBe(".mp4");
  });

  it("puts a root-level file in dir_posix '' rather than inventing a directory", () => {
    // '' is what 0004 documents for the root, and it is the prefix key the directory rollups group on. A
    // '.' or a '/' here would create a phantom directory in every rollup that reads the column.
    expect(fileFacets("README.md").dirPosix).toBe("");
    expect(fileFacets("README.md").baseName).toBe("README.md");
  });

  it("heals a Windows separator so both spellings land on ONE primary key", () => {
    // The primary key is `(unit_id, rel_posix)` with `rel_posix` GENERATED as replace(rel_path,'\','/').
    // Computing the same value here is what lets the writer dedupe a batch BEFORE the statement — without
    // it, a document carrying both spellings makes Postgres refuse the INSERT ("cannot affect row a second
    // time") and the whole 1,000-row batch fails on one pair of paths.
    expect(fileFacets("a\\b\\c.mp4").relPosix).toBe("a/b/c.mp4");
    expect(fileFacets("a\\b\\c.mp4").relPosix).toBe(fileFacets("a/b/c.mp4").relPosix);
    expect(fileFacets("a\\b\\c.mp4").dirPosix).toBe("a/b");
  });

  it("classifies the four media kinds, PDF included", () => {
    // `media_kind` is a FOUR-value enum and `mediaKindForName` only knows three of them — a PDF is not
    // media (no player, no IPFS payload) but it IS a first-class OCR target, so it has to reach the column.
    expect(fileFacets("a/b.mp4").media).toBe("video");
    expect(fileFacets("a/b.jpg").media).toBe("image");
    expect(fileFacets("a/b.mp3").media).toBe("audio");
    expect(fileFacets("a/b.pdf").media).toBe("pdf");
    expect(fileFacets("a/b.zip").media).toBeNull();
  });

  it("derives the four task verdicts as the NAME-ONLY floor, from the read path's own helpers", () => {
    // These mirror units.service.ts's compressStatusFor / transcribeStatusFor / describeStatusFor /
    // ocrStatusFor with their artifact leg removed — the artifact-aware upgrade is area 7's, and this
    // writer only ever states them on INSERT so that upgrade is never clobbered.
    const video = fileFacets("v/movie.mp4");
    expect(video).toMatchObject({ compress: "could", transcribe: "could", describe: "could", ocr: "could" });

    const audio = fileFacets("a/podcast.mp3");
    // Audio is not a compressible kind (charter: video first, image second) and has no pixels to read.
    expect(audio).toMatchObject({ compress: "na", transcribe: "could", describe: "na", ocr: "na" });

    const pdf = fileFacets("d/scan.pdf");
    expect(pdf).toMatchObject({ compress: "na", transcribe: "na", describe: "na", ocr: "could" });

    const zip = fileFacets("z/archive.zip");
    expect(zip).toMatchObject({ compress: "na", transcribe: "na", describe: "na", ocr: "na" });
  });

  it("reads the name's own already-compressed mark as `done`, not `could`", () => {
    // `compressInfo` treats a `…_compressed.mp4` name as already done (badges.ts VIDEO_COMPRESSED_MARK).
    // Getting this backwards would offer to re-compress every file the product has already compressed —
    // and re-compressing a compressed video is the one action that costs the user quality for nothing.
    expect(fileFacets("v/movie_compressed.mp4").compress).toBe("done");
    expect(fileFacets("v/movie.mp4").compress).toBe("could");
    // A JPEG is already a compressed image format; a PNG is the one we offer to convert.
    expect(fileFacets("i/photo.jpg").compress).toBe("done");
    expect(fileFacets("i/photo.png").compress).toBe("could");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE TRANSFORM ITSELF — `candidateRows`, exercised directly.
//
// Directly, and not through `BACKFILL_CANDIDATES.run()`, for a reason worth stating: `run()` resolves the
// unit id FIRST and returns early when there is none, precisely so a machine whose units have not been
// adopted does not parse an 820 KB document to discover it has nowhere to put it. That ordering is right
// for the real path and it makes the document branches unreachable from a database-less test — so the
// transform is exported and tested as what it is, a pure function of one parsed document.
describe("candidateRows — the transform, and the row it must never hand to the INSERT", () => {
  const statusWith = (candidatesYaml: string) =>
    UnitStatusSchema.parse(
      // Parsed through the REAL schema, not a hand-built object, so the test cannot drift from the shape
      // the backfill actually receives.
      YAML.parse(`schema_version: 1
last_scan_at: "2026-08-01T00:00:00.000Z"
repo_state: present
candidates:
${candidatesYaml}`),
    );

  it("drops a blank path, reports it, and keeps every other row", () => {
    const reasons: string[] = [];
    const rows = candidateRows(statusWith(`  - path: ""\n    size: 10\n  - path: a/ok.mp4\n    size: 20\n`), (r) =>
      reasons.push(r),
    );
    expect(reasons).toEqual(["candidate with an empty path"]);
    expect(rows.map((r) => r.relPath)).toEqual(["a/ok.mp4"]);
  });

  it("reports nothing for a clean document", () => {
    const reasons: string[] = [];
    candidateRows(statusWith(`  - path: a/ok.mp4\n    size: 20\n`), (r) => reasons.push(r));
    expect(reasons).toEqual([]);
  });

  it("emits rows in POSIX-sorted order — the resume cursor means nothing otherwise", () => {
    // The cursor is "the last path inserted"; an interrupted scope resumes at `> cursor`. Walk order is
    // directory-iteration order, which is neither sorted nor stable, so a resume against it would skip or
    // re-do an arbitrary slice of the unit.
    const rows = candidateRows(
      statusWith(`  - path: z/last.mp4\n    size: 1\n  - path: a/first.mp4\n    size: 2\n  - path: m/mid.mp4\n    size: 3\n`),
      () => {},
    );
    expect(rows.map((r) => r.relPath)).toEqual(["a/first.mp4", "m/mid.mp4", "z/last.mp4"]);
  });

  it("carries analysisOnly through and DROPS nudgeOnly on the floor", () => {
    // scanner.service.ts:52-55 states `nudgeOnly` is in-memory on purpose, every walk recomputes it, and
    // zero of the 105 status documents on this machine carry it. `analysisOnly` IS persisted, because the
    // frontend "Large files only" rail toggle reads it off each FileRow long after the scan. A document
    // that carries both must yield a row with the second and no trace of the first.
    const rows = candidateRows(
      statusWith(`  - path: a/small.jpg\n    size: 4\n    analysisOnly: true\n    nudgeOnly: true\n`),
      () => {},
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].analysisOnly).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual(["analysisOnly", "modifiedAt", "relPath", "sizeBytes"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// R2 AT THE AREA BOUNDARY — a scope on a machine with no Postgres.
describe("a scope whose unit has not been adopted records it and returns, rather than throwing", () => {
  it("names the status file and migrates nothing", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-area3-"));
    fs.mkdirSync(path.join(stateDir, "pin", "r", "somefolder"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "pin", "r", "somefolder", "status.yaml"),
      `schema_version: 1\nrepo_state: present\ncandidates:\n  - path: a/ok.mp4\n    size: 20\n`,
    );
    const priorState = process.env.LFB_STATE_DIR;
    const priorMode = process.env.LFB_DB_MODE;
    process.env.LFB_STATE_DIR = stateDir;
    // LFB_DB_MODE=off is also the live demonstration of R2: every helper the area calls answers honestly
    // with no pool, so the scope reaches a verdict instead of an exception.
    process.env.LFB_DB_MODE = "off";
    try {
      const scopes = await BACKFILL_CANDIDATES.scopes();
      const scope = scopes.find((s) => s.key === "r/somefolder")!;
      const rejects: Array<{ path: string; reason: string }> = [];
      const out = await BACKFILL_CANDIDATES.run(scope, {
        scope,
        resumeFrom: null,
        rowsBefore: 0,
        q,
        exec,
        copyRows,
        reject: (p, reason) => rejects.push({ path: p, reason }),
        checkpoint: () => {},
      });
      expect(out.rows).toBe(0);
      expect(rejects).toHaveLength(1);
      expect(rejects[0].path).toMatch(/status\.yaml$/);
      expect(rejects[0].reason).toContain("run adopt_units first");
    } finally {
      if (priorState === undefined) delete process.env.LFB_STATE_DIR;
      else process.env.LFB_STATE_DIR = priorState;
      if (priorMode === undefined) delete process.env.LFB_DB_MODE;
      else process.env.LFB_DB_MODE = priorMode;
    }
  });
});
