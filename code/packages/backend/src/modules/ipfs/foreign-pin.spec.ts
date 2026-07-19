// Foreign Pin Discovery store + prune tests (pm/foreign_pin_discovery.mdx). These lock the DAEMON-FREE
// parts: the global index round-trip (record → read → resolve by path / by canonical CID), the
// compatibility prune (verifyForeignPins drops a discovery another tool unpinned — §5.1), and the
// size-prune negative-cache path of discoverForeignPin (an empty kept-size band returns null WITHOUT
// hashing, so it needs no node). The live end-to-end check against the real daemon + the motivating file
// (2077951056697331723.mp4 / QmTo4Htjkqv…) is exercised separately (foreign_pin_discovery §7) since it
// requires that specific pinned file to be present.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalCid } from "./ipfs.service.js";
import * as m from "./foreign-pin.service.js";

const V0 = "QmTo4HtjkqvEMCvAUMDo6eP6FwroAp8r2btv1mqGSwyFFa";
const V0_CANON = canonicalCid(V0);

let tmpDir: string;
let prevStateDir: string | undefined;

// The module resolves its state-root paths (cache + index files) at CALL time via resolveStateDir(), which
// re-reads LFB_STATE_DIR each call — so a per-test temp state dir isolates the on-disk stores. The in-memory
// index cache is reset on every recordForeignPin write, and each test records before it reads.
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-fp-"));
  prevStateDir = process.env.LFB_STATE_DIR;
  process.env.LFB_STATE_DIR = tmpDir;
});
afterEach(() => {
  if (prevStateDir === undefined) delete process.env.LFB_STATE_DIR;
  else process.env.LFB_STATE_DIR = prevStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("foreign-pin global index (foreign_pin_discovery §5/§6)", () => {
  it("records a discovery and resolves it by abs path and by canonical CID", async () => {
    const abs = "/repo/videos/movie.mp4";
    m.recordForeignPin({ cid: V0, profile: "v0-dag-pb", absPath: abs, size: 2358647, repoRoot: "/repo" });

    const byPath = m.foreignPinByAbsPath(abs);
    expect(byPath?.cid).toBe(V0);
    expect(byPath?.canonicalCid).toBe(V0_CANON);
    expect(byPath?.profile).toBe("v0-dag-pb");

    // Reverse resolution keys on the CANONICAL cid, so a v1-spelling query still finds a v0 record.
    expect(m.foreignPinByCanonicalCid(V0)?.absPath).toBe(abs);
    expect(m.foreignPinByCanonicalCid(V0_CANON)?.absPath).toBe(abs);
  });

  it("upserts by path — a re-discovery replaces, never duplicates", async () => {
    const abs = "/repo/a.mp4";
    m.recordForeignPin({ cid: V0, profile: "v0-dag-pb", absPath: abs, size: 10, repoRoot: "/repo" });
    m.recordForeignPin({ cid: V0, profile: "v0-dag-pb", absPath: abs, size: 20, repoRoot: "/repo" });
    expect(m.readForeignPins()).toHaveLength(1);
    expect(m.foreignPinByAbsPath(abs)?.size).toBe(20);
  });

  it("verifyForeignPins drops a discovery whose CID the node no longer keeps (§5.1 — they unpinned it)", async () => {
    m.recordForeignPin({ cid: V0, profile: "v0-dag-pb", absPath: "/repo/gone.mp4", size: 1, repoRoot: "/repo" });
    // Kept-set WITHOUT this CID → the discovery must be pruned.
    m.verifyForeignPins(new Set<string>());
    expect(m.readForeignPins()).toHaveLength(0);
  });

  it("verifyForeignPins keeps a discovery still in the kept-set", async () => {
    m.recordForeignPin({ cid: V0, profile: "v0-dag-pb", absPath: "/repo/keep.mp4", size: 1, repoRoot: "/repo" });
    m.verifyForeignPins(new Set([V0_CANON]));
    expect(m.readForeignPins()).toHaveLength(1);
  });
});

describe("discoverForeignPin size-prune (foreign_pin_discovery §3)", () => {
  it("returns null WITHOUT hashing when no kept pin matches the file size (negative cache)", async () => {
    // Empty kept-size band ⇒ size-prune misses ⇒ null, no daemon call. Also writes a negative cache entry.
    const ctx = { keptSet: new Set<string>(), keptSizes: [] as number[] };
    const r = await m.discoverForeignPin("/does/not/matter.mp4", 12345, 999, ctx);
    expect(r).toBeNull();
    // Second call must be served from the negative cache (still null, still no hashing).
    expect(await m.discoverForeignPin("/does/not/matter.mp4", 12345, 999, ctx)).toBeNull();
  });
});
