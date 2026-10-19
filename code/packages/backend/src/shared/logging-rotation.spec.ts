// Logging: the 10 MiB rule and the two ways error.err reached 175 GB on 2026-10-19.
//
// Runner: vitest (`pnpm test` in this package).
//
// WHAT HAPPENED. Four orphaned Large File Bridge MCP servers appended to error.err with no cap, in an EPIPE loop,
// for hours. The backend's own RollingFileWriter never noticed: it seeded its byte counter ONCE and then counted
// only its own bytes. And any roll of an already-huge file renamed it whole into error.err.1, so the backup would
// have been 175 GB instead. These tests assert on the files on disk, not on the API.
//
// LFB_LOG_DIR is redirected BEFORE importing the module, because logging.ts resolves its files at import.
import { afterAll, afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-logging-rotation-"));
process.env.LFB_LOG_DIR = TMP;
process.env.LFB_STATE_DIR = TMP;

const { LOG_HARD_MAX_BYTES, RollingFileWriter, rotateIfOversized, capExternalLog, log } = await import(
  "./logging.js"
);

afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** `n` numbered lines of ~100 bytes — numbered so a test can tell head from tail. */
function lines(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += `line ${String(i).padStart(6, "0")} ${"x".repeat(86)}\n`;
  return s;
}

test("no log file may be configured past 10 MiB", () => {
  assert.equal(LOG_HARD_MAX_BYTES, 10 * 1024 * 1024);
});

test("rolling an oversized file keeps only its TAIL in .1, from a whole line", () => {
  const f = path.join(TMP, "huge.log");
  fs.writeFileSync(f, lines(1000)); // ~100 KB against a 10 KB cap
  rotateIfOversized(f, 10_000, 3);
  assert.equal(fs.existsSync(f), false);
  const kept = fs.readFileSync(`${f}.1`, "utf8");
  assert.ok(kept.length <= 10_000, `.1 is ${kept.length} bytes`);
  assert.match(kept, /^line \d{6} /, "starts on a line boundary, not mid-line");
  assert.match(kept, /line 000999 x+\n$/, "keeps the newest line");
});

test("an oversized backup already in the chain is cut down when it shifts", () => {
  const f = path.join(TMP, "chain.log");
  fs.writeFileSync(`${f}.1`, lines(1000)); // a legacy giant backup
  fs.writeFileSync(f, lines(150));
  rotateIfOversized(f, 10_000, 3);
  for (const g of [`${f}.1`, `${f}.2`]) {
    assert.ok(fs.statSync(g).size <= 10_000, `${path.basename(g)} is ${fs.statSync(g).size} bytes`);
  }
});

test("capExternalLog (copytruncate for held fds) also caps the copy it keeps", () => {
  const f = path.join(TMP, "daemon.log");
  fs.writeFileSync(f, lines(1000));
  assert.equal(capExternalLog(f, 10_000, 3), true);
  assert.equal(fs.statSync(f).size, 0, "live file truncated in place");
  assert.ok(fs.statSync(`${f}.1`).size <= 10_000);
});

test("the writer sees bytes ANOTHER process appended, and rolls", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = path.join(TMP, "shared.err");
  const w = new RollingFileWriter(f, 10_000, 3);
  w.writeSync("from the backend");
  fs.appendFileSync(f, lines(1000)); // the MCP server, appending behind the writer's back
  vi.setSystemTime(Date.now() + 2_000); // past RESTAT_MS
  w.writeSync("from the backend again");
  assert.equal(fs.readFileSync(f, "utf8").trim().endsWith("from the backend again"), true);
  assert.ok(fs.statSync(f).size < 10_000, "live file rolled, not appended to");
  assert.ok(fs.statSync(`${f}.1`).size <= 10_000, "and the overshoot was cut, not kept");
});

test("a broken stderr pipe is not an uncaughtException loop — logging carries on to the files", () => {
  const spy = vi.spyOn(process.stderr, "write");
  // What Node does when the reader of the pipe is gone: an 'error' EVENT, not a throw from write().
  process.stderr.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  spy.mockClear();
  log.error("test", "after the pipe broke");
  assert.equal(spy.mock.calls.length, 0, "stderr is not written again once it has failed");
  assert.match(fs.readFileSync(path.join(TMP, "error.err"), "utf8"), /after the pipe broke/);
  spy.mockRestore();
});
