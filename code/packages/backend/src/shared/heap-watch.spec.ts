// Child-process RSS attribution (to_fix.mdx §6.1, row E1). Runner: vitest.
//
// THE DEFECT THIS GUARDS. `registerChildProcess` shipped fully written — dead-pid reaping, argv bounds,
// per-label attribution — and with ZERO callers. `childLabels` was permanently empty, so the warning's
// child clause could never fire and Whisper's ~2 GB/instance stayed invisible exactly as before. The
// mechanism existing is not the feature; the SPAWNERS CALLING IT is the feature.
//
// So there are two tests, and the first one is the important one:
//   1. A GUARD that every spawner still registers. This is what stops a future refactor from quietly
//      returning the subsystem to decorative.
//   2. A FUNCTIONAL check that a real child's RSS is actually read back and attributed.
import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerChildProcess, unregisterChildProcess, probeChildRss } from "./heap-watch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-heapwatch-test-"));
process.env.LFB_LOG_DIR = TMP;

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("GUARD: every long-lived child spawner registers with heap-watch (E1 has producers)", () => {
  // The spawners that matter: transcription (Whisper, ~2 GB/instance) and the describe path's ffmpeg.
  // If you add another long-lived spawner, add it here — an unregistered child is an invisible one.
  const spawners = [
    "../tools/transcribe/audio-prep.ts",
    "../tools/transcribe/Transcribe.ts",
    "../modules/describe/fit-media.ts",
  ];
  for (const rel of spawners) {
    const src = fs.readFileSync(path.join(HERE, rel), "utf8");
    assert.match(src, /registerChildProcess\(/, `${rel} must register its child — otherwise its RSS is invisible`);
    assert.match(src, /unregisterChildProcess\(/, `${rel} must unregister, or a dead pid is probed forever`);
  }
});

test("a registered child's RSS is read back and attributed to its label", { timeout: 20_000 }, async () => {
  // A real child holding a real ~200 MB buffer — the point is to prove we can see memory that lives
  // entirely outside our heap, which is the whole gap §6 describes.
  const child = spawn(process.execPath, ["-e", "const b=Buffer.alloc(200*1024*1024,1);setTimeout(()=>{},10000);"]);
  try {
    await new Promise((r) => setTimeout(r, 1500)); // let it actually touch the pages
    registerChildProcess(child.pid, "transcribe:interview.mp4");
    const snap = await probeChildRss();
    assert.ok(snap, "the ps probe must return a snapshot");
    assert.equal(snap.count, 1);
    assert.ok(snap.totalBytes > 50 * 1024 * 1024, `expected real RSS, got ${snap.totalBytes} bytes`);
    assert.match(snap.top[0], /transcribe:interview\.mp4=\d+MB/, "attributed to the JOB, not to an anonymous pid");
  } finally {
    unregisterChildProcess(child.pid);
    child.kill("SIGKILL");
  }
});

test("an unregistered child contributes nothing", async () => {
  const snap = await probeChildRss();
  assert.deepEqual(snap, { totalBytes: 0, top: [], count: 0 }, "no registered children ⇒ nothing to report");
});

test("register/unregister tolerate an undefined pid and a double-unregister", () => {
  // spawn() can yield a child with no pid on failure, and close+error can both fire.
  assert.doesNotThrow(() => registerChildProcess(undefined, "nope"));
  assert.doesNotThrow(() => unregisterChildProcess(undefined));
  assert.doesNotThrow(() => unregisterChildProcess(999999));
  assert.doesNotThrow(() => unregisterChildProcess(999999));
});

test("a dead child is reaped rather than probed forever", async () => {
  const child = spawn(process.execPath, ["-e", "0"]);
  const pid = child.pid;
  registerChildProcess(pid, "short-lived:x.mp4");
  await new Promise((r) => child.on("close", r));
  // `ps` omits an exited pid — that omission is the death certificate the probe reaps on.
  const snap = await probeChildRss();
  assert.equal(snap?.count, 0, "an exited child must drop out of the registry");
  const again = await probeChildRss();
  assert.deepEqual(again, { totalBytes: 0, top: [], count: 0 }, "and stay out");
});
