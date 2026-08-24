// THE LATCH — a one-time migration must cost nothing on the boots after the first (performance.mdx P-46).
//
// `migrateSyncToPin` reads and YAML-parses `config.yaml` AND `status.yaml` for every unit dir under
// `pin/r|s|c/*`. On the machine this was measured on that is 210+ parses, and it ran on EVERY boot to find
// nothing: `boot.migrate.sync-to-pin 754ms/1 call`, the largest single item left in the boot window once it
// was attributed for the first time. Every sibling migration in this directory already had a marker file;
// this one did not.
//
// Two properties, and the second is why the first is safe to have:
//   1. the second run reads nothing at all — the point;
//   2. a run that FAILED leaves no marker, so the next boot tries again. A latch that outlives an unfinished
//      job is worse than no latch: it converts a transient failure into a permanent one, silently.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { stringify } from "yaml";
import { migrateSyncToPin } from "./migrate-sync-to-pin.js";

const MARKER = ".sync-to-pin-migrated";

let stateDir: string;
const roots: string[] = [];

/** A state root holding N repo units in the POST-migration shape — nothing for the migration to do. */
function seed(units: number): void {
  for (let i = 0; i < units; i++) {
    const dir = path.join(stateDir, "pin", "r", `repo${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yaml"), stringify({ pinned: true, repo: { path: `/tmp/r${i}` } }));
    fs.writeFileSync(path.join(dir, "status.yaml"), stringify({ pin: { last_at: null } }));
  }
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-sync-to-pin-"));
  roots.push(stateDir);
});
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe("migrateSyncToPin latches", () => {
  it("reads every unit file on the first run and NONE on the second", () => {
    seed(12);
    const spy = vi.spyOn(fs, "readFileSync");

    migrateSyncToPin(stateDir);
    const firstRunReads = spy.mock.calls.filter(([f]) => String(f).endsWith(".yaml")).length;
    expect(firstRunReads).toBeGreaterThan(0); // it really did walk the units
    expect(fs.existsSync(path.join(stateDir, MARKER))).toBe(true);

    spy.mockClear();
    migrateSyncToPin(stateDir);
    // Not "fewer reads" — NONE. The whole point is that the second boot does not touch the unit files.
    expect(spy.mock.calls.filter(([f]) => String(f).endsWith(".yaml"))).toEqual([]);
    spy.mockRestore();
  });

  it("still MIGRATES on the first run — the latch must not be the only thing that happens", () => {
    const dir = path.join(stateDir, "pin", "r", "legacy");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yaml"), stringify({ synced: true, repo: { path: "/tmp/legacy" } }));

    migrateSyncToPin(stateDir);

    const after = fs.readFileSync(path.join(dir, "config.yaml"), "utf8");
    expect(after).toContain("pinned: true");
    expect(after).not.toContain("synced:");
  });

  it("leaves NO marker when the run throws, so the next boot re-tries", () => {
    seed(2);
    // Fail inside the walk. The function's own backstop catches it (a broken migration must never crash
    // boot) — the assertion is that catching it does not also record the job as done.
    const spy = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("disk went away mid-migration");
    });
    migrateSyncToPin(stateDir);
    spy.mockRestore();

    expect(fs.existsSync(path.join(stateDir, MARKER))).toBe(false);

    // …and the retry works and latches normally.
    migrateSyncToPin(stateDir);
    expect(fs.existsSync(path.join(stateDir, MARKER))).toBe(true);
  });
});
