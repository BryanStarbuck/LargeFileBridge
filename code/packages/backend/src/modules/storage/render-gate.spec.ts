// THE RENDER EQUALITY GATE (database.mdx §2.3), as a test.
//
// For every (unit, doc) on this machine: render the document from Postgres THROUGH ITS DESIGNATED
// SERIALIZER and compare sha256 against the bytes on disk. ZERO DIFFS, OR THE CUTOVER DOES NOT HAPPEN.
//
// WHY THIS IS THE RIGHT TEST AND NOT A ROW COUNT. `tracking-sync.service.ts` records that 58 of the last 60
// device commits were a lone `updated_at` line. Every travelling document in this app is serialized
// DETERMINISTICALLY for exactly that reason — an unchanged document must re-serialize byte-identically or
// git commits it, the peer pulls it, re-renders it its own way, and commits back. A renderer that is one
// byte off does not lose data; it turns the fleet into a re-render loop that nothing in the product would
// name. So the assertion has to be on BYTES.
//
// IT SKIPS, LOUDLY, WITHOUT A DATABASE — and it skips by DEFAULT. `vitest.config.ts` clamps `LFB_DB_MODE`
// to `off` and `LFB_STATE_DIR` to a throwaway temp dir for the whole suite, deliberately: an unredirected
// spec would otherwise read the user's real state root and write the user's real `largefilebridge`, which
// has happened once and was investigated as a production fault. `test.env` WINS over the shell, so this
// file opts in under names the baseline does not clamp — the same arrangement `decision-fold-gate.spec.ts`
// uses:
//
//     LFB_GATE_DATABASE_URL=postgresql://localhost:5432/<db> LFB_GATE_STATE_DIR=<state root> \
//       CI=true ./node_modules/.bin/vitest run src/modules/storage/render-gate.spec.ts
//
// `LFB_GATE_SIDECARS=1` adds the 29,138-document sidecar plane (minutes). Without it the gate covers the
// four whole-unit documents per repo, which is the sub-scope that currently PASSES.
//
// ── WHAT "PASSES" MEANS HERE, MEASURED 2026-08-24 ───────────────────────────────────────────────────────
//
//   103 manifest.yaml   from manifest_entry + pin_claim through `serializeManifest`   — 103/103 identical
//   103 decisions.yaml  from decision_event            through `serializeLedger`      — 103/103 identical
//   103 repo_storage.yaml, SCRUBBED MIRROR projection                                 — 103/103 identical
//   103 repo_storage.yaml, LOCAL copy (live `counts:`)                                — NOT COVERED
//   29,136 sidecars     from file + file_event + file_variant + file_fingerprint      — 13,268 identical,
//                                                                                       15,868 DIFFERENT
//
// The sidecar failures are ONE finding, not 15,868: `lfb.file.size_bytes` and `lfb.file.modified_at` are
// the LIVE scan census (area 3 writes them from a fresh `stat`), while a sidecar's `size:`/`modified:` are
// historical — the values as of when the sidecar was last written. `upsertSidecarFiles` (R5) correctly
// declines to overwrite the census, so the column holds the census's fact and the render says so. That is a
// column-ownership question for the schema, not a renderer bug, and it is why `renderWritesArmed()` is off.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isStrayPathHeal,
  renderRepoStorage,
  repoUnits,
  runRenderGate,
  type GateDiff,
} from "./doc-render.service.js";
import { resolveStateSyncRepo } from "./tracking-root.service.js";
import { refreshDbHealth } from "../../shared/persistence/db.js";
import { probeDatabase, resolveDbMode } from "../../shared/persistence/pool.js";

// Opt in to the real corpus and the real (scratch) database BEFORE anything resolves a path or a pool.
// Both resolvers read `process.env` on every call, so assigning at module scope is enough.
if (process.env.LFB_GATE_STATE_DIR) process.env.LFB_STATE_DIR = process.env.LFB_GATE_STATE_DIR;
if (process.env.LFB_GATE_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.LFB_GATE_DATABASE_URL;
  process.env.LFB_DB_MODE = "required";
}

const reachable = resolveDbMode() !== "off" && (await probeDatabase()).reachable;
if (reachable) await refreshDbHealth();
const withSidecars = process.env.LFB_GATE_SIDECARS === "1";

describe.skipIf(!reachable)("every Category-B document renders from Postgres byte-for-byte", () => {
  it("renders identical bytes for every whole-unit document it can source", async () => {
    const report = await runRenderGate({ sidecars: withSidecars });
    expect(report.units.length).toBeGreaterThan(0);

    // The report is printed whether it passes or fails: "what did this actually cover" is the question
    // anyone reading a green gate asks next, and a gate that hides its scope is how "0 diffs" becomes a
    // number about how many slices remain rather than about correctness.
    const w = process.stdout.write.bind(process.stdout);
    w(`\n  scope: ${withSidecars ? "whole-unit documents + the sidecar plane" : "whole-unit documents only"}\n`);
    w(`  ${report.units.length} unit(s), ${report.scanned} document(s) on disk examined in ${report.ms} ms\n`);
    w(`  identical: ${report.matched}   different: ${report.diffs.length}   no lfb.file row: ${report.absentInPg}\n`);
    for (const [reason, n] of [...report.unsourced].sort((a, b) => b[1] - a[1])) {
      w(`  NOT COVERED (${n}): ${reason}\n`);
    }

    // Group the failures by SHAPE. 15,868 sidecars failing the same way is one finding; printing 15,868
    // lines would bury it.
    const byShape = new Map<string, { n: number; example: string; delta: string | null }>();
    for (const d of report.diffs) {
      const shape = `${d.doc}/${d.reason}/${(d.firstDelta ?? "").replace(/"[^"]*"/g, '"…"')}`;
      const hit = byShape.get(shape);
      if (hit) hit.n += 1;
      else byShape.set(shape, { n: 1, example: d.file, delta: d.firstDelta });
    }
    const summary = [...byShape]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 12)
      .map(([, v]) => `${v.n}x ${v.example} :: ${v.delta ?? "(absent on disk)"}`);

    expect(summary, `The render equality gate found ${report.diffs.length} differing document(s).`).toEqual([]);
  }, 900_000);

  it("renders the SCRUBBED mirror repo_storage.yaml byte-for-byte", async () => {
    // THE ONE DOCUMENT WHOSE MIRROR COPY IS RENDERABLE WHILE ITS LOCAL COPY IS NOT, and the asymmetry is
    // the whole point. `RepoStorageCountsSchema` is nine counters that `lfb.unit_rollup` does not carry, so
    // the LOCAL file — which holds this computer's live counts and `last_scan` — cannot be rendered.
    // `projectRepoStorageToMirror` resets exactly those two blocks to their schema defaults on the way out
    // (`MACHINE_LOCAL_REPO_STORAGE`, tracking-sync.service.ts), so the two blocks Postgres cannot source
    // are precisely the two the wire does not carry. Measured 2026-08-24: 103 of 103.
    //
    // This is READ-ONLY against the SDLs. Nothing in this slice writes one.
    const units = await repoUnits();
    let match = 0;
    const diffs: string[] = [];
    for (const u of units) {
      const subtree = resolveStateSyncRepo(u.absPath);
      if (!subtree) continue;
      const file = path.join(subtree, "repo_storage.yaml");
      let disk: string;
      try {
        disk = fs.readFileSync(file, "utf8");
      } catch {
        continue; // this repo has never mirrored — nothing to compare
      }
      const out = await renderRepoStorage(u.unitId, { scrub: true });
      if (out.status === "unsourced") {
        diffs.push(`${file}: ${out.reason}`);
        continue;
      }
      if (createHash("sha256").update(disk, "utf8").digest("hex") === out.sha256) {
        match += 1;
        continue;
      }
      const a = disk.split("\n");
      const b = out.text.split("\n");
      const i = a.findIndex((l, n) => l !== b[n]);
      diffs.push(`${file} line ${i + 1}: disk=${JSON.stringify(a[i])} pg=${JSON.stringify(b[i])}`);
    }
    process.stdout.write(`\n  scrubbed mirror repo_storage.yaml: ${match} identical, ${diffs.length} different\n`);
    expect(diffs).toEqual([]);
    expect(match).toBeGreaterThan(0);
  }, 300_000);

  it("covers the two multi-megabyte travelling documents for every adopted repo", async () => {
    // A gate that passed because it examined nothing would be worse than a failing one. `decisions.yaml`
    // and `manifest.yaml` are the documents this whole workstream is about — 18,234 events and 4,184
    // manifest entries on this machine — so the gate must be able to say it looked at one of each per unit.
    const report = await runRenderGate({ sidecars: false });
    const perUnit = report.scanned / Math.max(1, report.units.length);
    expect(perUnit).toBeGreaterThanOrEqual(2);
    expect(report.matched).toBeGreaterThanOrEqual(report.units.length * 2);
  }, 300_000);
});

// ── the stray-path classifier (database.mdx §3) ────────────────────────────────────────────────────────
//
// THE CASE IT EXISTS FOR, measured 2026-08-24: three sidecars sit at a HEALED location on disk while their
// own `path:` field still carries the pre-heal Windows spelling. `sidecar-heal.ts` fixed where the file
// lives; it did not rewrite what the file says. Postgres files the row under the filename-derived POSIX
// spelling because `rel_posix` is a STORED GENERATED column AND the primary key — which is exactly what
// makes the stray-path fork "structurally impossible instead of healed by hand".
//
// So Postgres is right, the document is stale, and no renderer change can or should reproduce it. Counting
// it as a failure would leave the gate permanently red for something nobody intends to fix, which is how a
// gate stops being read at all. These tests pin the classifier NARROW, because a loose one would swallow a
// real regression.
describe("isStrayPathHeal — an intended divergence, and nothing else", () => {
  const diff = (firstDelta: string | null, over: Partial<GateDiff> = {}): GateDiff => ({
    doc: "sidecar",
    docKey: "k",
    file: "/x.yaml",
    reason: "diff",
    diskSha: "a",
    renderSha: "b",
    diskBytes: 1,
    renderBytes: 1,
    firstDelta,
    ...over,
  });
  // `firstDeltaOf` renders both sides with JSON.stringify, so a single backslash in the document arrives in
  // the delta as the two characters \\ . Build the fixtures the same way or the test proves nothing.
  const delta = (disk: string, pg: string): string =>
    `line 33: disk=${JSON.stringify(disk)} pg=${JSON.stringify(pg)}`;

  it("accepts the real shape: backslashes on disk, forward slashes in Postgres", () => {
    expect(isStrayPathHeal(diff(delta("  path: _mix\\rotten\\27k.csv", "  path: _mix/rotten/27k.csv")))).toBe(true);
  });

  it("rejects a path that differs by more than its separators", () => {
    // The whole risk of this classifier: calling two DIFFERENT files equal.
    expect(isStrayPathHeal(diff(delta("  path: a\\b.csv", "  path: a/c.csv")))).toBe(false);
  });

  it("rejects a delta on any key other than path", () => {
    expect(isStrayPathHeal(diff(delta("  name: a\\b.csv", "  name: a/b.csv")))).toBe(false);
  });

  it("rejects it when POSTGRES is the side carrying backslashes", () => {
    // That direction would mean we had STORED the stray spelling — the bug the generated rel_posix primary
    // key exists to prevent. It is a real diff and must never be filed as healed.
    expect(isStrayPathHeal(diff(delta("  path: a/b.csv", "  path: a\\b.csv")))).toBe(false);
  });

  it("rejects a diff with no backslash at all", () => {
    expect(isStrayPathHeal(diff(delta("  path: a/b.csv", "  path: a/b/c.csv")))).toBe(false);
  });

  it("rejects a TRUNCATED delta, where the tails were never compared", () => {
    // firstDeltaOf clips at 110 chars and appends an ellipsis. Two paths equal in their first 110 characters
    // are not equal, and treating them as healed would hide exactly the mismatch the gate is for.
    const long = "  path: " + "a\\".repeat(80);
    expect(isStrayPathHeal(diff(delta(long.slice(0, 110) + "…", long.replace(/\\/g, "/").slice(0, 110) + "…")))).toBe(false);
  });

  it("rejects a non-sidecar document and a non-diff reason", () => {
    const good = delta("  path: a\\b.csv", "  path: a/b.csv");
    expect(isStrayPathHeal(diff(good, { doc: "manifest" }))).toBe(false);
    expect(isStrayPathHeal(diff(good, { reason: "missing-on-disk" }))).toBe(false);
  });

  it("rejects an absent or unparseable delta rather than guessing", () => {
    expect(isStrayPathHeal(diff(null))).toBe(false);
    expect(isStrayPathHeal(diff("line 3: something entirely different"))).toBe(false);
  });
});
