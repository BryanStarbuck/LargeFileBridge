// SLICE 12 — the batch-manifest projection's PARSE half, tested without a database.
//
// Every assertion here is about a property that would be invisible in a row count: a crashed batch that
// projected as "no verdict yet", a re-ingest that duplicated, an outcome list that ate its own retries. The
// SQL half is exercised for real against a scratch database by the backfill (see the slice's verification);
// what is pinned here is the meaning, which is the part that has to survive a refactor.
//
// LFB_STATE_DIR is redirected BEFORE the import, exactly as batch-manifest.spec.ts does it: state-dir.ts
// reads the env at call time, and `resolveBatchesDir()` would otherwise read (and create in) the user's real
// ~/T/_large_files_bridge/_batches. That ordering is why the import below is a dynamic `await import`.
import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-batch-index-"));
process.env.LFB_STATE_DIR = TMP;

const { parseManifest, manifestFiles, manifestStat, ManifestUnusableError } = await import("./batch-index.service.js");

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const BATCHES = path.join(TMP, "_batches");
fs.mkdirSync(BATCHES, { recursive: true });

/** Write a manifest document verbatim and hand back its path. */
function manifest(name: string, body: string): string {
  const file = path.join(BATCHES, name);
  fs.writeFileSync(file, body, "utf8");
  return file;
}

const HEADER = (id: string, extra = "") =>
  `batch_id: ${id}\nop: ocr\nstarted: 2026-08-01T00:00:00.000Z\nscope: 2 checked path(s)\n${extra}`;

test("a manifest with NO terminal record projects as crashed — the ABSENCE is the signal (§4.2)", () => {
  const f = manifest(
    "2026-08-01_00-00-00_ocr_2_11111111.yaml",
    HEADER("11111111-1111-4111-8111-111111111111") +
      "files:\n  - path: /x/a.png\n    size_bytes: 10\n  - path: /x/b.png\n    size_bytes: 20\n" +
      'outcomes:\n  - {"path":"/x/a.png","outcome":"ocred"}\n',
  );
  const m = parseManifest(f);
  assert.equal(m.terminalState, "crashed", "no terminal record ⇒ crashed, never null");
  assert.equal(m.finishedAt, null, "and no finish time is invented for it");
  assert.equal(m.items.length, 2);
});

test("a batch that died BEFORE its first outcome still projects — `outcomes:` parses as null", () => {
  // THE REGRESSION THIS PINS. `writeManifest` ends its header write with a bare `outcomes:\n` and leaves the
  // key open for O(1) appends. A batch killed before any file settled therefore leaves `outcomes: null`,
  // which `z.array(...).default([])` rejects — and the batch whose crash record matters most would have been
  // the one the projection dropped. Found by running the real backfill against a hand-built document of
  // exactly this shape; `yaml-store.ts:103` records the same trap for the config stores.
  const f = manifest(
    "2026-08-01_00-01-00_ocr_2_22222222.yaml",
    HEADER("22222222-2222-4222-8222-222222222222") +
      "files:\n  - path: /x/a.png\n    size_bytes: 10\n  - path: /x/b.png\n    size_bytes: 20\noutcomes:\n",
  );
  const m = parseManifest(f);
  assert.equal(m.terminalState, "crashed");
  assert.equal(m.items.length, 2, "both intended files survive as items");
  assert.deepEqual(
    m.items.map((i) => i.outcome),
    [null, null],
    "with no outcome — which is what makes them show up as unfinished",
  );
});

test("a completed manifest carries its terminal state and finish time", () => {
  const f = manifest(
    "2026-08-01_00-02-00_ocr_1_33333333.yaml",
    HEADER("33333333-3333-4333-8333-333333333333") +
      "files:\n  - path: /x/a.png\n    size_bytes: 10\n" +
      'outcomes:\n  - {"path":"/x/a.png","outcome":"ocred"}\n' +
      "finished: 2026-08-01T00:03:00.000Z\nterminal_state: completed\nfinal_counts:\n  ocred: 1\n",
  );
  const m = parseManifest(f);
  assert.equal(m.terminalState, "completed");
  assert.equal(m.finishedAt?.toISOString(), "2026-08-01T00:03:00.000Z");
  assert.equal(m.items[0].outcome, "ocred");
});

test("the LAST outcome for a path wins, and a retried file is one row not two", () => {
  const f = manifest(
    "2026-08-01_00-04-00_ocr_1_44444444.yaml",
    HEADER("44444444-4444-4444-8444-444444444444") +
      "files:\n  - path: /x/a.png\n    size_bytes: 10\n" +
      'outcomes:\n  - {"path":"/x/a.png","outcome":"failed","reason":"provider timeout"}\n' +
      '  - {"path":"/x/a.png","outcome":"ocred"}\n' +
      "finished: 2026-08-01T00:05:00.000Z\nterminal_state: completed\n",
  );
  const m = parseManifest(f);
  assert.equal(m.items.length, 1, "(batch_id, rel_path) is the identity — a retry is not a second row");
  assert.equal(m.items[0].outcome, "ocred", "the verdict that stands is the last one recorded");
  assert.equal(m.items[0].reason, null);
  assert.equal(m.items[0].sizeBytes, 10, "and the size from the file list survives the overlay");
});

test("a duplicated path in the FILE LIST is deduped — Postgres refuses two rows with one conflict key", () => {
  const f = manifest(
    "2026-08-01_00-06-00_ocr_2_55555555.yaml",
    HEADER("55555555-5555-4555-8555-555555555555") +
      "files:\n  - path: /x/a.png\n    size_bytes: 10\n  - path: /x/a.png\n    size_bytes: 10\noutcomes:\n",
  );
  const m = parseManifest(f);
  assert.equal(m.items.length, 1, "deduped in TypeScript, before the INSERT that would otherwise abort whole");
  assert.equal(m.fileCount, 2, "but file_count still reports what the batch set out to do");
});

test("an outcome for a path the file list never named is KEPT", () => {
  const f = manifest(
    "2026-08-01_00-07-00_ocr_1_66666666.yaml",
    HEADER("66666666-6666-4666-8666-666666666666") +
      "files:\n  - path: /x/a.png\n    size_bytes: 10\n" +
      'outcomes:\n  - {"path":"/x/a.png","outcome":"ocred"}\n' +
      '  - {"path":"/x/surprise.png","outcome":"ocred"}\n',
  );
  const m = parseManifest(f);
  assert.equal(m.items.length, 2, "a real record of work done is not something a projection may discard");
  assert.equal(m.items.find((i) => i.relPath === "/x/surprise.png")?.sizeBytes, null);
});

test("a non-uuid batch_id is UNUSABLE, with a message fit for the reject table", () => {
  const f = manifest(
    "2026-08-01_00-08-00_ocr_0_77777777.yaml",
    "batch_id: not-a-uuid\nop: ocr\nstarted: 2026-08-01T00:00:00.000Z\nfiles: []\noutcomes:\n",
  );
  assert.throws(
    () => parseManifest(f),
    (e: unknown) => e instanceof ManifestUnusableError && /not a uuid/.test((e as Error).message),
  );
});

test("a half-written final append is UNUSABLE, not a crash of the whole area", () => {
  // The most likely real cause of a YAML syntax error here is the crash the manifest exists to record.
  const f = manifest(
    "2026-08-01_00-09-00_ocr_1_88888888.yaml",
    HEADER("88888888-8888-4888-8888-888888888888") +
      "files:\n  - path: /x/a.png\n    size_bytes: 10\n" +
      'outcomes:\n  - {"path":"/x/a.png","outcome":"ocre\n',
  );
  assert.throws(() => parseManifest(f), ManifestUnusableError);
});

test("a manifest with no usable `started` is UNUSABLE rather than stamped with now()", () => {
  // `started_at` is NOT NULL and is the sort key of `batch_manifest_recent`; inventing a timestamp would put
  // a weeks-old document at the top of "what ran last night".
  const f = manifest(
    "2026-08-01_00-10-00_ocr_0_99999999.yaml",
    "batch_id: 99999999-9999-4999-8999-999999999999\nop: ocr\nstarted: not-a-date\nfiles: []\noutcomes:\n",
  );
  assert.throws(() => parseManifest(f), ManifestUnusableError);
});

test("manifestStat is the freshness token, and manifestFiles sorts chronologically", () => {
  const files = manifestFiles();
  assert.ok(files.length >= 2);
  assert.deepEqual([...files].sort(), files, "names sort chronologically — listing order is the file order");
  const st = manifestStat(files[0]);
  assert.ok(st && st.sizeBytes > 0 && st.mtimeMs > 0);
  assert.equal(manifestStat(path.join(BATCHES, "nope.yaml")), null, "a vanished file is null, never a throw");
});
