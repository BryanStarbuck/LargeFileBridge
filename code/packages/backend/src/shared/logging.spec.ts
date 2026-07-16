// Logging: batch context + repeat collapse (to_fix.mdx §4.4 / §4.5, rows C7/C8).
//
// Runner: vitest (`pnpm test` in this package).
//
// WHY THESE TESTS EXIST. Both features were fully IMPLEMENTED and completely INERT: `withLogContext` had
// no call site anywhere, so `contextTag()` always rendered ""; and both writers were constructed without
// `collapseRepeats`, whose default is false, so `[×N since HH:MM]` could never be emitted. Neither
// defect was detectable by typecheck, by review of the (correct, well-commented) implementation, or by
// any grep short of "is this actually called?" — the code read exactly like working code.
//
// That is the failure mode these tests are really for: a mechanism that is switched off is
// indistinguishable from one that is switched on until something OBSERVES its output. So they assert on
// the bytes in the file, not on the API.
//
// LFB_LOG_DIR is redirected BEFORE importing the module, because logging.ts resolves its files at import.
import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-logging-test-"));
process.env.LFB_LOG_DIR = TMP;
process.env.LFB_STATE_DIR = TMP;

const { log, withLogContext, withBatchContext, currentBatchId, flushLogs } = await import("./logging.js");

const ERR_FILE = path.join(TMP, "error.err");
const LOG_FILE = path.join(TMP, "log.log");
const read = (f: string): string => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("a log line inside a batch scope carries batch= and op= (§4.4, C7)", () => {
  withLogContext({ batchId: "batch-alpha", op: "describe" }, () => {
    log.error("test", "something broke in alpha");
  });
  const err = read(ERR_FILE);
  assert.match(err, /\[batch=batch-alpha op=describe\]/, "the tag must reach the file, not just exist in the API");
  assert.match(err, /something broke in alpha/);
});

test("the tag survives async continuations — the whole point of AsyncLocalStorage", async () => {
  await withLogContext({ batchId: "batch-async", op: "transcribe" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    log.error("test", "logged after an await");
  });
  assert.match(read(ERR_FILE), /\[batch=batch-async op=transcribe\] logged after an await/);
});

test("one grep on a batch_id reconstructs that run and excludes others (§4.4's actual promise)", () => {
  withLogContext({ batchId: "batch-mine", op: "describe" }, () => log.error("test", "mine one"));
  withLogContext({ batchId: "batch-other", op: "describe" }, () => log.error("test", "theirs"));
  withLogContext({ batchId: "batch-mine", op: "describe" }, () => log.error("test", "mine two"));

  const lines = read(ERR_FILE).split("\n").filter((l) => l.includes("batch=batch-mine"));
  assert.equal(lines.length, 2, "exactly this batch's lines");
  assert.ok(!lines.join("\n").includes("theirs"), "and none of anyone else's");
});

test("currentBatchId is readable inside a scope and undefined outside it", () => {
  assert.equal(currentBatchId(), undefined);
  withBatchContext("batch-read", () => assert.equal(currentBatchId(), "batch-read"));
  assert.equal(currentBatchId(), undefined, "the scope must not leak past its callback");
});

test("an unscoped line is unchanged — no tag, no regression for existing call sites", () => {
  log.error("test", "plain unscoped error");
  const line = read(ERR_FILE).split("\n").find((l) => l.includes("plain unscoped error")) ?? "";
  assert.ok(!line.includes("[batch="), "no empty [] noise on the vast majority of lines");
  assert.match(line, /\[ERROR\] \[test\] plain unscoped error/);
});

test("a fault storm collapses instead of burying the signal (§4.5, C8)", () => {
  const before = read(ERR_FILE).split("\n").length;
  // The incident's shape: the same fault, thousands of times, differing only in the file it names.
  for (let i = 0; i < 500; i++) {
    log.error("test", `429 RESOURCE_EXHAUSTED: prepayment credits are depleted for /tmp/file${i}.mp4`);
  }
  const after = read(ERR_FILE).split("\n").length;
  const written = after - before;
  assert.ok(
    written < 20,
    `500 near-identical faults wrote ${written} lines — collapse is off. This is what rotated error.err.1 ` +
      `past 5 MiB on 2026-07-15 and destroyed the earlier evidence.`,
  );

  flushLogs(); // summarize the folded run (this is what flushLogs must do, and once did not)
  assert.match(read(ERR_FILE), /\[×\d+ since \d\d:\d\d\]/, "the suppressed run must be summarized, never silently dropped");
});

test("collapse still lets a DIFFERENT fault through immediately", () => {
  log.error("test", "a completely unrelated and novel failure");
  assert.match(read(ERR_FILE), /a completely unrelated and novel failure/, "a new fact is never suppressed");
});

test("the first occurrence of a fault is always written through, synchronously", () => {
  // Collapse must never DELAY a fault reaching disk — it may only suppress the repeats behind it.
  log.error("test", "first-of-its-kind marker XYZZY");
  assert.match(read(ERR_FILE), /first-of-its-kind marker XYZZY/, "no flush needed for the first line");
});

test("errors land in BOTH error.err and log.log (the fault trail and the context)", () => {
  log.error("test", "dual-written marker PLUGH");
  assert.match(read(ERR_FILE), /dual-written marker PLUGH/);
  assert.match(read(LOG_FILE), /dual-written marker PLUGH/);
});
