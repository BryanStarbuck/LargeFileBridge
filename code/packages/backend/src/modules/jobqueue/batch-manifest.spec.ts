// Batch manifest round-trip (to_fix.mdx §9 "Unit — … manifest round-trip", rows C1/C2/C5).
//
// Runner: vitest (`pnpm test` in this package).
//
// LFB_STATE_DIR is redirected to a temp dir BEFORE importing the service, because state-dir.ts reads the
// env at call time and we must never write test manifests into the user's real ~/T/_large_files_bridge.
// That ordering is why the import below is a dynamic `await import` rather than a static one.
import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-manifest-test-"));
process.env.LFB_STATE_DIR = TMP;

const { writeManifest, appendOutcome, finalizeManifest, listManifests, readManifest, trackBatch, settleOne } = await import(
  "./batch-manifest.service.js"
);

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("the manifest carries the FULL file list, written before any outcome (§4.1)", () => {
  const files = Array.from({ length: 25 }, (_, i) => ({ path: `/tmp/a${i}.mp4`, sizeBytes: 1000 + i }));
  const h = writeManifest({ op: "describe", scope: "root /tmp", provider: "gemini", files });

  const doc = YAML.parse(fs.readFileSync(h.file, "utf8"));
  assert.equal(doc.op, "describe", "op is explicit, never inferred");
  assert.equal(doc.provider, "gemini");
  assert.equal(doc.files.length, 25, "the file list is mandatory — without it a lost batch is unreconstructable");
  assert.equal(doc.files[0].path, "/tmp/a0.mp4");
  assert.equal(doc.files[0].size_bytes, 1000);
  assert.ok(doc.batch_id, "a batch_id must exist to join the logs against");
  assert.ok(doc.environment.machine_ram_gb > 0, "environment is captured at click time");
});

test("a manifest with no terminal record reads as CRASHED (§4.2)", () => {
  const h = writeManifest({ op: "describe", scope: "s", files: [{ path: "/tmp/x.mp4" }] });
  const open = listManifests().find((m) => m.batchId === h.batchId);
  assert.equal(open?.finished, null, "no terminal record ⇒ crashed — the durable signal");

  finalizeManifest(h, "completed", { described: 1 });
  const closed = listManifests().find((m) => m.batchId === h.batchId);
  assert.equal(closed?.terminalState, "completed");
  assert.ok(closed?.finished, "a finalized batch carries its finish time");
});

test("appended outcomes keep the document valid YAML at every instant", () => {
  const h = writeManifest({ op: "describe", scope: "s", files: [{ path: "/a.mp4" }, { path: "/b.mp4" }] });
  appendOutcome(h, "/a.mp4", "described");
  // A reason containing a colon and a quote would break a naive hand-rolled YAML line.
  appendOutcome(h, "/b.mp4", "failed", 'boom: the "provider" said no');
  finalizeManifest(h, "completed", { described: 1, failed: 1 });

  const doc = YAML.parse(fs.readFileSync(h.file, "utf8"));
  assert.equal(doc.outcomes.length, 2);
  assert.equal(doc.outcomes[0].outcome, "described");
  assert.equal(doc.outcomes[1].reason, 'boom: the "provider" said no', "punctuation survives the round-trip");
  assert.equal(doc.final_counts.failed, 1);
});

test("halted is NOT failed, and a halted file stays re-queueable (§2.4/§7.3/§4.3)", () => {
  const h = writeManifest({ op: "describe", scope: "s", files: [{ path: "/x.mp4" }, { path: "/y.mp4" }, { path: "/z.mp4" }] });
  appendOutcome(h, "/x.mp4", "described");
  appendOutcome(h, "/y.mp4", "halted", "credits depleted");
  finalizeManifest(h, "halted", { described: 1, halted: 1 });

  const r = readManifest(h.batchId);
  assert.ok(r);
  // /y was halted (never attempted) and /z was never reached — both must come back for the re-queue.
  // /x succeeded and must NOT: re-describing it would be wasted spend.
  assert.deepEqual(r.unfinished.sort(), ["/y.mp4", "/z.mp4"]);
});

test("the batch closes itself when its last file settles (§4.2, C5)", () => {
  const h = writeManifest({ op: "transcribe", scope: "s", files: [{ path: "/1.mp4" }, { path: "/2.mp4" }] });
  trackBatch(h.batchId, 2);

  settleOne(h.batchId, "/1.mp4", "transcribed");
  assert.equal(listManifests().find((m) => m.batchId === h.batchId)?.finished, null, "still open with work outstanding");

  settleOne(h.batchId, "/2.mp4", "transcribed");
  const done = listManifests().find((m) => m.batchId === h.batchId);
  assert.equal(done?.terminalState, "completed", "the last file settling closes the manifest");
});

test("a batch that ends with a halted file is terminal-stated `halted`, not `completed`", () => {
  const h = writeManifest({ op: "describe", scope: "s", files: [{ path: "/p.mp4" }, { path: "/q.mp4" }] });
  trackBatch(h.batchId, 2);
  settleOne(h.batchId, "/p.mp4", "described");
  settleOne(h.batchId, "/q.mp4", "halted", "credits depleted");
  assert.equal(listManifests().find((m) => m.batchId === h.batchId)?.terminalState, "halted");
});

test("two identical batches in the same second do NOT overwrite each other", () => {
  // Regression: the file name was once stamp+op+count, which collides for two same-second clicks on the
  // same folder — silently destroying the first batch's only durable record. Both must survive.
  const a = writeManifest({ op: "describe", scope: "s", files: [{ path: "/dup1.mp4" }] });
  const b = writeManifest({ op: "describe", scope: "s", files: [{ path: "/dup2.mp4" }] });
  assert.notEqual(a.file, b.file, "same second + same op + same count must still get distinct files");
  assert.ok(fs.existsSync(a.file) && fs.existsSync(b.file), "both manifests are on disk");
  assert.equal(YAML.parse(fs.readFileSync(a.file, "utf8")).files[0].path, "/dup1.mp4", "the first was not clobbered");
});

test("settling a task with no batch is a harmless no-op (a one-off job has no manifest)", () => {
  assert.doesNotThrow(() => settleOne(undefined, "/one-off.mp4", "described"));
  assert.doesNotThrow(() => appendOutcome(undefined, "/one-off.mp4", "described"));
});
