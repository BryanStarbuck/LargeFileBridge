// Locks the SDL `.lfbridge/` → ROOT migration (artifact_placement_policy.mdx §0.3, migrate-sdl-lfbridge.ts
// `migrateOne`). The defect these tests repeal, proven live 2026-07-18…07-20: on a genuine file-vs-file
// conflict the migration kept the root copy, LEFT the `.lfbridge/` copy in the working tree, and WARNed —
// every single boot. 84 identical WARNs in error.err in two days, `.lfbridge/` never prunable, TWO divergent
// copies of the same state on disk, and (because an SDL commits its tree) the leftover kept travelling to the
// user's other computers, which pushed it straight back: act3_large_files_bridge `.lfbridge/manifest.yaml`
// was deleted 07-15, resurrected 07-17, deleted again 07-20. Converging means the loser LEAVES the tree —
// preserved byte-for-byte in Local Storage, never destroyed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { migrateOne } from "./migrate-sdl-lfbridge.js";
import { clearStorageTypeCache } from "../modules/storage/storage-type.service.js";

let tmp: string;
let root: string;
let prevStateDir: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-migrate-sdl-"));
  prevStateDir = process.env.LFB_STATE_DIR;
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  // An SDL by naming convention (`*_large_files_bridge`) — no `.git/`, so no `git mv` path is exercised.
  root = path.join(tmp, "acme_large_files_bridge");
  fs.mkdirSync(path.join(root, ".lfbridge"), { recursive: true });
  clearStorageTypeCache();
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.LFB_STATE_DIR;
  else process.env.LFB_STATE_DIR = prevStateDir;
  fs.rmSync(tmp, { recursive: true, force: true });
  clearStorageTypeCache();
});

function write(rel: string, body: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
  return p;
}

function conflictMarker(): Record<string, { dst: string; quarantined_to?: string }> {
  const raw = fs.readFileSync(path.join(process.env.LFB_STATE_DIR!, "migration_conflicts.yaml"), "utf8");
  return (parse(raw) as { conflicts: Record<string, { dst: string; quarantined_to?: string }> }).conflicts;
}

describe("migrateOne — SDL .lfbridge/ → root", () => {
  it("moves an entry whose destination is absent and prunes the emptied .lfbridge/", () => {
    write(".lfbridge/devices/mac.yaml", "device: mac\n");
    expect(migrateOne(root)).toBe(1);
    expect(fs.readFileSync(path.join(root, "devices/mac.yaml"), "utf8")).toBe("device: mac\n");
    expect(fs.existsSync(path.join(root, ".lfbridge"))).toBe(false);
    expect(migrateOne(root)).toBe(0); // idempotent: the re-run is an immediate no-op
  });

  it("drops a byte-identical duplicate and a YAML duplicate that differs only in updated_at", () => {
    write(".lfbridge/manifest.yaml", "schema_version: 1\nfiles: []\n");
    write("manifest.yaml", "schema_version: 1\nfiles: []\n");
    write(".lfbridge/devices/mac.yaml", "device: mac\nupdated_at: 2026-07-01T00:00:00Z\n");
    write("devices/mac.yaml", "device: mac\nupdated_at: 2026-07-20T00:00:00Z\n");

    expect(migrateOne(root)).toBe(2);
    expect(fs.existsSync(path.join(root, ".lfbridge"))).toBe(false);
    // The live root copies are untouched — the duplicate never overwrote them.
    expect(fs.readFileSync(path.join(root, "devices/mac.yaml"), "utf8")).toContain("2026-07-20");
    expect(fs.existsSync(path.join(process.env.LFB_STATE_DIR!, "migration_conflicts.yaml"))).toBe(false);
  });

  it("CONVERGES on a genuine conflict: root copy wins, loser is preserved in Local Storage, .lfbridge/ goes", () => {
    const loser = write(".lfbridge/manifest.yaml", "schema_version: 1\nfiles:\n  - path: old.mp4\n");
    write("manifest.yaml", "schema_version: 1\nfiles:\n  - path: new.mp4\n");

    expect(migrateOne(root)).toBe(1);

    // The winner is byte-for-byte untouched; the tree converged (nothing left to re-migrate).
    expect(fs.readFileSync(path.join(root, "manifest.yaml"), "utf8")).toContain("new.mp4");
    expect(fs.existsSync(loser)).toBe(false);
    expect(fs.existsSync(path.join(root, ".lfbridge"))).toBe(false);

    // Nothing was destroyed: the loser's bytes live in the machine-local quarantine, recorded as a tombstone.
    const rec = conflictMarker()[loser];
    expect(rec.dst).toBe(path.join(root, "manifest.yaml"));
    expect(rec.quarantined_to).toBe(
      path.join(process.env.LFB_STATE_DIR!, "migration_conflicts", "acme_large_files_bridge", "manifest.yaml"),
    );
    expect(fs.readFileSync(rec.quarantined_to!, "utf8")).toContain("old.mp4");

    // …and the migration is DONE for that item: a second boot finds nothing and cannot re-warn.
    expect(migrateOne(root)).toBe(0);
  });

  it("drops a peer-resurrected leftover whose bytes are already quarantined, without a second copy", () => {
    const body = "schema_version: 1\nfiles:\n  - path: old.mp4\n";
    const loser = write(".lfbridge/manifest.yaml", body);
    write("manifest.yaml", "schema_version: 1\nfiles:\n  - path: new.mp4\n");
    migrateOne(root);
    const quarantined = conflictMarker()[loser].quarantined_to!;

    // A computer still running the legacy layout pushes the same file back; the next pull restores it.
    write(".lfbridge/manifest.yaml", body);
    expect(migrateOne(root)).toBe(1);

    expect(fs.existsSync(loser)).toBe(false);
    expect(fs.existsSync(path.join(root, ".lfbridge"))).toBe(false);
    expect(fs.existsSync(`${quarantined}.1`)).toBe(false); // already preserved → no duplicate pile-up
  });
});
