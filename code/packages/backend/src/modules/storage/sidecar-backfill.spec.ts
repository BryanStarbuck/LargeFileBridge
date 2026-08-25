// SLICE 9's THREE SILENT FAILURES.
//
// Each of these is a single expression whose wrong version produces no error at all. It shows up much later
// as "the AI descriptions were all regenerated and the bill doubled", or "the database is holding 70 MB of
// OCR text it was never supposed to see", or "the verification passed on a different 200 files every run so
// nobody could reproduce the failure". So each one gets a test that states what it must not do.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { readArtifactHeader, sampleEvenly, legacyTranscriptPath } from "./sidecar-backfill.js";
import { analysisOutputs, analysisOutputsFromDisk, resetAnalysisOutputsPrime } from "./tracking.service.js";
import { appendFileEvent, ensureSidecar, readSidecar } from "./file-sidecar.service.js";
import {
  derivedFileColumns,
  fingerprintBits,
  isEmailToken,
  relPosixKey,
  resetUnitIdCache,
} from "../store-model/file-detail.repo.js";

function tmpDir(name: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lfb-${name}-`));
  return fs.realpathSync(d);
}

describe("readArtifactHeader — the body must never reach the database", () => {
  // `.ai_description` and `.ocr` bodies are CATEGORY-A CONTENT: 31.0 MB of descriptions and 70.8 MB of OCR
  // text on this machine. They stay in files. The header fields (status/engine/provider/generated/language)
  // are the only thing the index is allowed to lift out, and the block scalar is the boundary.
  const dir = tmpDir("hdr");

  it("reads the header fields and STOPS at the `description:` block scalar", () => {
    const f = path.join(dir, "a.ai_description");
    fs.writeFileSync(
      f,
      [
        "source: testing thumnail image.png",
        "status: done",
        "engine: gemini-flash-latest",
        "provider: gemini",
        "generated: 2026-08-20T12:59:36.289Z",
        "kind: image",
        "description: >-",
        "  ## Overview",
        "",
        "  engine: THIS IS BODY TEXT AND MUST NOT BE READ AS A FIELD",
        "  provider: neither is this",
      ].join("\n"),
    );
    const h = readArtifactHeader(f);
    expect(h.engine).toBe("gemini-flash-latest");
    expect(h.provider).toBe("gemini");
    expect(h.generatedAt?.toISOString()).toBe("2026-08-20T12:59:36.289Z");
  });

  it("stops at `text:` too, so an OCR body cannot leak a field", () => {
    const f = path.join(dir, "b.ocr");
    fs.writeFileSync(
      f,
      ["status: done", "engine: vision", "language: en-US", "text: |-", "  engine: forged", "  ACT 3 ai"].join("\n"),
    );
    const h = readArtifactHeader(f);
    expect(h.engine).toBe("vision");
    expect(h.language).toBe("en-US");
  });

  it("returns nothing for a plain-text transcript — its first lines are prose, not fields", () => {
    // `.transcription` opens "Transcription of: <name>" / "Generated on: <date>" / "Model used: whisper-base".
    // Those are sentences with colons in them, not a header, and guessing at them would put invented
    // metadata in a table whose entire job is answering questions truthfully.
    const f = path.join(dir, "c.transcription");
    fs.writeFileSync(f, "Transcription of: x.mp4\nGenerated on: 2026-07-07 22:48:28\nModel used: whisper-base\n");
    const h = readArtifactHeader(f);
    expect(h.engine).toBeNull();
    expect(h.provider).toBeNull();
    expect(h.generatedAt).toBeNull();
  });

  it("never throws on a missing or unreadable body", () => {
    expect(readArtifactHeader(path.join(dir, "does-not-exist.ocr"))).toEqual({
      engine: null,
      provider: null,
      language: null,
      generatedAt: null,
    });
  });
});

describe("sampleEvenly — a gate that blocks a read cutover cannot be unreproducible", () => {
  it("returns the SAME sample every call", () => {
    const items = Array.from({ length: 1000 }, (_, i) => `f${i}`);
    expect(sampleEvenly(items, 200)).toEqual(sampleEvenly(items, 200));
  });

  it("spreads across the whole corpus rather than taking a prefix", () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const s = sampleEvenly(items, 10);
    expect(s).toHaveLength(10);
    expect(s[0]).toBe(0);
    expect(s[9]).toBeGreaterThan(800); // a prefix sample would end at 9 and never see the tail
  });

  it("returns everything when there is less than a full sample", () => {
    expect(sampleEvenly([1, 2, 3], 200)).toEqual([1, 2, 3]);
  });
});

describe("legacyTranscriptPath — the placement the app's own probe does not look in", () => {
  // `<sdl>/.transcribe/<rel>.txt`. `describe.service.ts:56` and `ocr.service.ts:39` both SKIP `.transcribe`
  // when they walk, so nothing in the product reports a transcript that lives only there. Thirty of them
  // exist on this machine.
  const root = tmpDir("legacy");

  it("finds a legacy transcript and heals nothing else", () => {
    const rel = "_Mirror/Politics/Blue_Side.mp4";
    const p = path.join(root, ".transcribe", "_Mirror", "Politics", "Blue_Side.mp4.txt");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "Transcription of: Blue_Side.mp4\n");
    expect(legacyTranscriptPath(root, rel)).toBe(p);
    // And the app's own probe does NOT see it — which is precisely why the index has to.
    expect(analysisOutputsFromDisk(root, rel)).not.toContain("transcript");
  });

  it("returns null when there is no legacy transcript", () => {
    expect(legacyTranscriptPath(root, "_Mirror/Politics/absent.mp4")).toBeNull();
  });
});

describe("the Postgres read never asserts a MISSING", () => {
  beforeEach(() => {
    resetAnalysisOutputsPrime();
    resetUnitIdCache();
  });

  it("falls through to the disk probe with no database, and agrees with it exactly", async () => {
    // R2: `LFB_DB_MODE` is unset in the test environment, so `dbEnabled()` is false and nothing is primed.
    // The answer must be byte-identical to the pre-slice behaviour — this is the no-regression assertion.
    const root = tmpDir("nopg");
    const rel = "videos/x.mp4";
    const art = path.join(root, ".lfbridge", "videos", "x.mp4.transcription");
    fs.mkdirSync(path.dirname(art), { recursive: true });
    fs.writeFileSync(art, "hello");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true }); // a working repo → `.lfbridge/` is its base
    expect(analysisOutputs(root, rel)).toEqual(analysisOutputsFromDisk(root, rel));
    expect(analysisOutputs(root, rel)).toContain("transcript");
  });
});

describe("the sidecar dual-write cannot break the YAML writer", () => {
  it("writes the sidecar and appends the event with no database at all (R1 + R2)", () => {
    // The YAML is the authority and the thing `mirrorToSyncRepo` copies (database.mdx §6.2). If the mirror
    // could throw — or could be skipped in a way that changed what lands on disk — the sync protocol itself
    // would depend on a database the charter says may not be there.
    const stateDir = tmpDir("state");
    const prevState = process.env.LFB_STATE_DIR;
    process.env.LFB_STATE_DIR = stateDir;
    try {
      const repo = tmpDir("repo");
      const rel = "videos/trees.mov";
      expect(ensureSidecar(repo, rel, { size: 1234, categories: ["video"] })).not.toBeNull();
      appendFileEvent(repo, rel, { kind: "observed", by: null, note: "scan" });
      const doc = readSidecar(repo, rel);
      expect(doc?.file.path).toBe(rel);
      expect(doc?.file.events).toHaveLength(1);
      expect(doc?.file.events[0].by).toBeNull(); // the 18-of-29,138 case NULLS NOT DISTINCT exists for
    } finally {
      if (prevState === undefined) delete process.env.LFB_STATE_DIR;
      else process.env.LFB_STATE_DIR = prevState;
    }
  });
});

describe("the derived columns are pure functions of the primary key", () => {
  // This is the ONLY reason more than one writer of `lfb.file` may set them without breaking R5: two
  // writers computing them from the same `rel_posix` cannot disagree, so there is no column to clobber.
  it("splits a nested key into dir / base / ext / media", () => {
    expect(derivedFileColumns("videos/a/trees.MOV")).toEqual({
      baseName: "trees.MOV",
      dirPosix: "videos/a",
      fileExt: ".mov",
      media: "video",
    });
  });

  it("uses '' for the root directory, which is the dir-rollup prefix key", () => {
    expect(derivedFileColumns("trees.mov").dirPosix).toBe("");
  });

  it("classifies a PDF as media even though it has no player (ocr.mdx §1.7.1)", () => {
    expect(derivedFileColumns("docs/x.pdf").media).toBe("pdf");
    expect(derivedFileColumns("src/x.ts").media).toBeNull();
  });

  it("heals a Windows-spelled key, because rel_posix is the join every peer uses", () => {
    expect(relPosixKey("a\\b\\c.mp4")).toBe("a/b/c.mp4");
    expect(derivedFileColumns(relPosixKey("a\\b\\c.mp4")).dirPosix).toBe("a/b");
  });
});

describe("the two dimension splits", () => {
  it("keeps `not-lfbridge` and `pull-retry` out of the email column", () => {
    // `person` has three UNIQUE identity columns. Putting a sentinel in the citext `email` column would make
    // it collide with a future real user of that string and would corrupt decision attribution, which reads
    // the same table.
    expect(isEmailToken("not-lfbridge")).toBe(false);
    expect(isEmailToken("pull-retry")).toBe(false);
    expect(isEmailToken("bikash@act3ai.com")).toBe(true);
    // `cli@localhost` IS an address and is stored as one — an actor with an address, just not a Google one.
    expect(isEmailToken("cli@localhost")).toBe(true);
  });

  it("refuses anything that is not exactly 256 bits for the bit(256) column", () => {
    expect(fingerprintBits("f".repeat(64))).toBe("1".repeat(256));
    expect(fingerprintBits("0".repeat(64))).toBe("0".repeat(256));
    expect(fingerprintBits("abc")).toBeNull();
    expect(fingerprintBits("z".repeat(64))).toBeNull();
  });
});
