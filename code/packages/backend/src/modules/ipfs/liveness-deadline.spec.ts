// THE BANNER'S LIVENESS POLL ANSWERS WITHIN A DEADLINE (error catalog #19).
//
// `GET /api/ipfs/liveness` awaited `ipfs.health()` — up to two 15 s probes on a busy or just-woken daemon —
// so a poll whose only job is "should the banner nag?" held a socket past request-watch's 10 s STILL OPEN
// line and the client's 45 s timeout. The route now answers within its deadline: the fresh answer if it
// arrives in time, else the last one it computed (marked stale), else an honest 503 — never a guessed
// `running:false`.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.LFB_LIVENESS_DEADLINE_MS = "80";

let livenessImpl: () => Promise<unknown> = async () => ({});
vi.mock("./ipfs-node.service.js", () => ({
  liveness: () => livenessImpl(),
  nodeStatus: vi.fn(),
  startInstall: vi.fn(),
  getJob: vi.fn(),
  controlDaemon: vi.fn(),
  restartDaemon: vi.fn(),
  startUpgrade: vi.fn(),
}));
vi.mock("../auth/identify.js", () => ({ requireAllowListed: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../scanner/scanner.service.js", () => ({ scanAll: vi.fn() }));
vi.mock("./ipfs-page.service.js", () => ({ computeIpfsPage: vi.fn(), importPins: vi.fn(), syncedPinTargets: vi.fn() }));
vi.mock("../storage/decisions.service.js", () => ({ recordDecision: vi.fn() }));
vi.mock("./ipfs-config-health.service.js", () => ({ configHealth: vi.fn(), repairConfig: vi.fn() }));
vi.mock("./ipfs-autostart.service.js", () => ({ installAutostart: vi.fn(), removeAutostart: vi.fn() }));

const express = (await import("express")).default;
const { ipfsRouter, resetLivenessMemo } = await import("./ipfs.router.js");

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use("/api/ipfs", ipfsRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ipfs/liveness`;
});
afterAll(() => server.close());
beforeEach(() => resetLivenessMemo());

const UP = { installed: true, running: true, autostartSupported: true, willStartOnBoot: true, configBlocker: false };

describe("GET /api/ipfs/liveness — bounded", () => {
  it("answers fresh when liveness() is quick", async () => {
    livenessImpl = async () => UP;
    const r = await fetch(base);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, data: UP });
  });

  it("answers with the LAST known state, marked stale, when the daemon is slow — instead of hanging", async () => {
    livenessImpl = async () => UP;
    await fetch(base); // remembered
    livenessImpl = () => new Promise(() => {}); // a wedged health probe
    const t0 = Date.now();
    const r = await fetch(base);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await r.json()).toEqual({ ok: true, data: UP, stale: true });
  });

  it("says 'not yet' (503) with nothing remembered — never a guessed running:false", async () => {
    livenessImpl = () => new Promise(() => {});
    const r = await fetch(base);
    expect(r.status).toBe(503);
    const body = (await r.json()) as { ok: boolean; data?: unknown };
    expect(body.ok).toBe(false);
    expect(body.data).toBeUndefined();
  });
});
