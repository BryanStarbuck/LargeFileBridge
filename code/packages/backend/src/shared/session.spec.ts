// The previous-session verdict (crash_recovery.mdx §5.1) — the durable input D2 derives from.
//
// Runner: vitest (`pnpm test` in this package).
//
// The rule under test: **BOOT without a following SHUTDOWN ⇒ the previous session died.** An OOM abort
// runs no JS, so a crashing process can never write its own epitaph — the ONLY evidence is the marker
// that is missing. Everything here is about reading an absence correctly.
import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-session-test-"));
process.env.LFB_LOG_DIR = TMP;
process.env.LFB_STATE_DIR = TMP;

const { readPreviousSessionEnd } = await import("./transactions.js");
const TXN = path.join(TMP, "transactions.log");

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const boot = (t: string) => `[${t}] [BOOT]      [process] pid=1 node=v26\n`;
const shutdown = (t: string) => `[${t}] [SHUTDOWN]  [process] pid=1\n`;
const work = (t: string, msg = "op=describe file=/a.mp4") => `[${t}] [BEGIN]     [queue_task] ${msg}\n`;

function writeLedger(body: string): void {
  fs.writeFileSync(TXN, body, "utf8");
}

test("BOOT followed by SHUTDOWN ⇒ clean", () => {
  writeLedger(boot("2026-07-15T10:00:00.000Z") + work("2026-07-15T10:01:00.000Z") + shutdown("2026-07-15T10:05:00.000Z"));
  const r = readPreviousSessionEnd();
  assert.equal(r.previousEnded, "clean");
  assert.equal(r.previousEndedAt, "2026-07-15T10:05:00.000Z");
});

test("BOOT with NO SHUTDOWN ⇒ abnormal — the 2026-07-15 shape", () => {
  // The real incident: work logged right up to 22:13, then nothing. No goodbye was ever written because
  // the process was aborted by V8, not asked to leave.
  writeLedger(boot("2026-07-15T21:35:00.000Z") + work("2026-07-15T22:13:00.000Z", "op=describe file=/last.mp4"));
  const r = readPreviousSessionEnd();
  assert.equal(r.previousEnded, "abnormal");
  assert.equal(r.previousEndedAt, "2026-07-15T22:13:00.000Z", "time of death = the last sign of life");
});

test("only the LAST boot matters — an earlier clean session doesn't excuse a later crash", () => {
  writeLedger(
    boot("2026-07-14T09:00:00.000Z") +
      shutdown("2026-07-14T17:00:00.000Z") + // yesterday ended fine…
      boot("2026-07-15T21:35:00.000Z") +
      work("2026-07-15T22:13:00.000Z"), // …tonight did not
  );
  assert.equal(readPreviousSessionEnd().previousEnded, "abnormal");
});

test("a clean run after an earlier crash reads clean — we report the LAST session, not the worst", () => {
  writeLedger(
    boot("2026-07-15T21:35:00.000Z") +
      work("2026-07-15T22:13:00.000Z") + // the crash
      boot("2026-07-16T04:00:00.000Z") +
      shutdown("2026-07-16T05:00:00.000Z"), // then a clean session
  );
  assert.equal(readPreviousSessionEnd().previousEnded, "clean");
});

test("no ledger at all ⇒ clean (a first-ever run has no previous session to have lost)", () => {
  fs.rmSync(TXN, { force: true });
  fs.rmSync(`${TXN}.1`, { force: true });
  assert.equal(readPreviousSessionEnd().previousEnded, "clean");
});

test("a ledger with no BOOT ⇒ unknown, NOT clean (rotation ate the evidence)", () => {
  // The dangerous case: we cannot affirmatively assert nothing was interrupted, so §5's LOCKED rule says
  // render Interrupted. Claiming `clean` here would resurrect the exact confident lie D2 kills.
  writeLedger(work("2026-07-15T22:13:00.000Z") + work("2026-07-15T22:14:00.000Z"));
  assert.equal(readPreviousSessionEnd().previousEnded, "unknown");
});

test("the verb is read from its COLUMN, not from anywhere in the line", () => {
  // A file named BOOT.mp4 (or an error quoting the word) must not read as a process restart.
  writeLedger(
    boot("2026-07-15T10:00:00.000Z") +
      shutdown("2026-07-15T10:05:00.000Z") +
      work("2026-07-15T10:06:00.000Z", "op=describe file=/videos/BOOT SHUTDOWN.mp4"),
  );
  const r = readPreviousSessionEnd();
  assert.equal(r.previousEnded, "clean", "a path containing BOOT/SHUTDOWN must not be parsed as a marker");
});

test("falls back to the rotated generation when the live file has no BOOT", () => {
  fs.writeFileSync(`${TXN}.1`, boot("2026-07-15T21:35:00.000Z") + work("2026-07-15T22:13:00.000Z"), "utf8");
  fs.writeFileSync(TXN, "", "utf8"); // freshly rotated, nothing in it yet
  assert.equal(readPreviousSessionEnd().previousEnded, "abnormal", "the crash is one generation back, not gone");
  fs.rmSync(`${TXN}.1`, { force: true });
});
