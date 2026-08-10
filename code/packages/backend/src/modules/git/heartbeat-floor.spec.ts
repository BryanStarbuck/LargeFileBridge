// THE HEARTBEAT FLOOR (devices.mdx §7.1) — the exception that makes the quiet gate's silence survivable.
//
// The quiet gate exists for a good reason: a device record re-stamps `updated_at` on every pass, and
// committing that produced 2,322 one-line commits in 7 days on the live personal repo. But `deviceRows()`
// reads a peer's `lastSeen` straight off that same `updated_at`, so dropping it unconditionally made
// liveness UNANSWERABLE. Measured 2026-08-10: this Mac Pro's published record was stamped Aug 3 — the last
// day anything substantive changed — so every peer concluded it had been offline for a week, and pull-downs
// failed with "<computer> looks offline. Bring it online and try again." about computers that were running
// the whole time. That is the single fault these tests exist to prevent from coming back.
import { describe, it, expect } from "vitest";
import { isDeviceRecordPath } from "./git.service.js";
// The floor itself is a LEAF module on purpose: it has to hold at TWO layers that must not import each
// other — the WRITER (devices.service.ts `writeSelfDevice`, which otherwise never re-stamps the file at
// all) and the COMMITTER (the quiet gate below). Fixing either alone changes nothing, which is exactly
// what happened the first time: the gate was taught the floor while the writer kept the file clean, so
// the stamp still never moved.
import { heartbeatIsStale, HEARTBEAT_MAX_AGE_MS } from "../../shared/heartbeat.js";

const NOW = Date.parse("2026-08-10T16:00:00.000Z");
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();

describe("isDeviceRecordPath — which files carry a liveness signal", () => {
  it("recognizes a device record at the SDL root and nested under a storage", () => {
    expect(isDeviceRecordPath("devices/bryan-mac-pro.yaml")).toBe(true);
    expect(isDeviceRecordPath("some/storage/devices/laptop.yaml")).toBe(true);
  });

  it("recognizes the Windows-shaped path too — the gate reads whatever git printed", () => {
    expect(isDeviceRecordPath("devices\\bryan-mac-pro.yaml")).toBe(true);
  });

  it("is false for every other document — only device records get the exception", () => {
    expect(isDeviceRecordPath("repos/abc/repo_storage.yaml")).toBe(false);
    expect(isDeviceRecordPath("manifest.yaml")).toBe(false);
    expect(isDeviceRecordPath("devices/README.md")).toBe(false);
  });
});

describe("heartbeatIsStale — when a published heartbeat has aged out", () => {
  it("holds a heartbeat that is fresher than the floor — the flood the gate was written for stays dead", () => {
    expect(heartbeatIsStale({ updated_at: agoMs(60_000) }, NOW)).toBe(false);
    expect(heartbeatIsStale({ updated_at: agoMs(HEARTBEAT_MAX_AGE_MS - 1) }, NOW)).toBe(false);
  });

  it("lets one through once it is older than the floor — the Aug-3-stamp-in-an-Aug-10-world case", () => {
    expect(heartbeatIsStale({ updated_at: agoMs(HEARTBEAT_MAX_AGE_MS + 1) }, NOW)).toBe(true);
    expect(heartbeatIsStale({ updated_at: "2026-08-03T11:24:05.442Z" }, NOW)).toBe(true);
  });

  it("treats an absent or unparseable stamp as stale — a record nobody can date is the one to republish", () => {
    expect(heartbeatIsStale({}, NOW)).toBe(true);
    expect(heartbeatIsStale({ updated_at: "not a date" }, NOW)).toBe(true);
    expect(heartbeatIsStale({ updated_at: 12345 as unknown as string }, NOW)).toBe(true);
  });

  it("costs at most 4 commits per computer per day", () => {
    expect(24 * 60 * 60 * 1000 / HEARTBEAT_MAX_AGE_MS).toBe(4);
  });
});
