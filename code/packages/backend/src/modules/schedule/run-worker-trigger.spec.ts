// The launchd trigger must DIAGNOSE, not guess.
//
// The bug this guards (2026-07-21, 9 occurrences in 2 days). `pin`/`device` awaited their entire pass inside
// the HTTP request, so the trigger sat on the socket for minutes, aborted at its 60s client timeout, and
// wrote to error.err:
//
//   [WARN] [run-worker] device: backend unreachable at POST …/api/internal/run/device
//          (This operation was aborted) — app not running? Skipping this interval.
//
// Three false claims in one line. The app WAS running (the pass kept logging for another 90s after the
// abort). "This operation was aborted" is a CLIENT-side timeout and UND_ERR_SOCKET is a socket teardown —
// neither is evidence about the server's state. And nothing was "skipped": Express cannot cancel an async
// handler because the client hung up, so the work ran to completion while the fault trail said it hadn't.
//
// The fix is the interaction SHAPE — the kick is fire-and-acknowledge — plus honest classification of the
// three genuinely different failures. These tests run the REAL trigger script against real sockets.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const TRIGGER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../deploy/launchd/run-worker.mjs",
);

let stateDir: string;

function runTrigger(port: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [TRIGGER, "pin", String(port)],
      {
        env: {
          ...process.env,
          LFB_STATE_DIR: stateDir,
          LFB_WORKER_ACK_TIMEOUT_MS: "300", // keep the dead-backend paths sub-second
          LFB_WORKER_ATTEMPTS: "2",
        },
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code?: number }).code! : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function misses(): Record<string, { reason: string; consecutive: number }> {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, "worker-misses.json"), "utf8"));
  } catch {
    return {};
  }
}

/** A free port nothing is listening on — for the genuine "app is down" case. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-trigger-"));
});
afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("run-worker trigger — fire-and-acknowledge", () => {
  it("returns as soon as the app ACCEPTS the job, even though the work runs for far longer", async () => {
    // The backend under test behaves the way internal.router.ts now does: accept, answer, keep working.
    let workFinished = false;
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { ran: "pin", accepted: true, started: true } }));
      setTimeout(() => (workFinished = true), 2_000); // the detached pass, still going
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;

    const started = Date.now();
    const res = await runTrigger(port);
    const elapsed = Date.now() - started;
    srv.close();

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("accepted by the app");
    // The whole point: the trigger does not hold the request open for the pass.
    expect(workFinished).toBe(false);
    expect(elapsed).toBeLessThan(1_500);
    // A delivered cycle is not a missed one.
    expect(misses().pin).toBeUndefined();
    // And it must never emit the old, wrong diagnosis.
    expect(res.stderr).not.toMatch(/app not running/i);
    expect(res.stderr).not.toMatch(/Skipping this interval/i);
  });

  it("a backend that is UP but slow to answer is never reported as 'app not running' or as a skipped cycle", async () => {
    // The exact live condition that produced the bogus WARNs: the socket connects, the server just never
    // answers in time. The trigger must abort its own wait and say so HONESTLY.
    const srv = http.createServer(() => {
      /* accept the connection, never respond */
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;

    const res = await runTrigger(port);
    srv.close();

    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/app not running/i);
    expect(res.stderr).not.toMatch(/Skipping this interval/i);
    expect(res.stderr).toMatch(/no acknowledgement/i);
    // It PROBED liveness and reported the truth: the port is accepting connections.
    expect(res.stderr).toMatch(/IS accepting connections/);
    // Recorded as a delivery problem — an ack timeout, NOT an app-down.
    expect(misses().pin.reason).toBe("ack-timeout");
  });

  it("a genuinely absent app is reported as absent, recorded, and exits 0", async () => {
    const port = await freePort(); // nothing is listening here
    const res = await runTrigger(port);

    expect(res.code).toBe(0); // launchd must keep firing a healthy trigger
    expect(res.stderr).toMatch(/Large File Bridge is not running/);
    expect(misses().pin.reason).toBe("app-not-running");
    // The record is durable and counts consecutive misses, so nothing vanishes into the next 15 minutes.
    const before = misses().pin.consecutive;
    await runTrigger(port);
    expect(misses().pin.consecutive).toBe(before + 1);
  });
});
