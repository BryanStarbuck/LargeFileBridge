// AREA 4's THREE SILENT-IF-WRONG PIECES (database_migration.mdx §4.4).
//
// None of these needs a database, and none of them is a database question: each one is a single expression
// whose wrong version produces no error, no reject and no warning — it just quietly makes the migration
// non-idempotent or makes it skip a mirror that is right there on disk.
//
//   1. `rel_path` byte-exactness. `decision_event_identity` includes the RAW path, so a normalized copy is a
//      DIFFERENT event and re-inserts on every run, forever.
//   2. The mirror subtree matched by `repoUid` SUFFIX, never by exact directory name. `<sdl>/repos/` holds a
//      mix of `<slug>-<uid>` and legacy bare `<uid>` directories; matching on the name silently skips the
//      legacy ones, and "this repo has never mirrored" is indistinguishable from "we did not look properly".
//   3. The resume cursor's `<leg>:<offset>` shape. A cursor that does not round-trip restarts the wrong leg.
//
// The whole-corpus equality gate — `file_decision` = `foldLedger(readLedger(root))` for every unit — is the
// other half of this slice's verification and lives in `decision-fold-gate.spec.ts`, because it needs a
// database and the real 18,234-event corpus to mean anything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { DecisionEvent } from "@lfb/shared";
import { decisionScopes, parseCursor, toInsert } from "./decision-backfill.js";
import { repoKeyFor } from "./tracking-root.service.js";

describe("rel_path is byte-exact — a normalized copy re-inserts forever", () => {
  const event = (p: string): DecisionEvent => ({
    sid: "r:1298871ad952",
    path: p,
    fingerprint: null,
    asked: true,
    ipfs: true,
    gitignore: false,
    decided_by: null,
    decided_at: "2026-07-20T19:08:27.841Z",
  });

  it("keeps a Windows-separator path exactly as the ledger recorded it", () => {
    // `ledger-merge.ts:24-26` joins the RAW path into the event identity, so healing it here would produce
    // an event that can never collide with the one on disk. The POSIX spelling still exists — as the
    // GENERATED `rel_posix` column, which is what the fold and every read key on.
    const row = toInsert(event("jfk\\training\\clip.mp4"), 7, "local");
    expect(row.relPath).toBe("jfk\\training\\clip.mp4");
  });

  it("carries the nullable columns through as NULL, which is why the UNIQUE is NULLS NOT DISTINCT", () => {
    // `fingerprint` and `decided_by` are `.nullable().default(null)` (schemas.ts:607/611) and are null on
    // essentially the whole corpus. Under Postgres's DEFAULT null semantics two byte-identical events with a
    // null in either column never collide, and every re-run would insert them again.
    const row = toInsert(event("a/b.mp4"), 7, "local");
    expect(row.fingerprint).toBeNull();
    expect(row.decidedBy).toBeNull();
  });

  it("stamps origin per leg — the local ledger is 'local', an SDL mirror is 'wire'", () => {
    expect(toInsert(event("a/b.mp4"), 7, "local").origin).toBe("local");
    expect(toInsert(event("a/b.mp4"), 7, "wire").origin).toBe("wire");
  });
});

describe("the resume cursor round-trips as <leg>:<offset>", () => {
  it("splits on the LAST colon, so an SDL leg key containing one still parses", () => {
    expect(parseCursor("local:500")).toEqual({ leg: "local", offset: 500 });
    expect(parseCursor("act3_large_files_bridge:0")).toEqual({ leg: "act3_large_files_bridge", offset: 0 });
    expect(parseCursor("weird:name:1200")).toEqual({ leg: "weird:name", offset: 1200 });
  });

  it("treats an absent or unparseable cursor as 'start from the beginning'", () => {
    // Anything else would resume from a position nobody computed. Starting over is always SAFE here — the
    // UNIQUE makes re-inserting an already-migrated prefix a no-op — so this is the one direction to fail in.
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor("local")).toBeNull();
    expect(parseCursor("local:nope")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE MIRROR MATCH
//
// Built by hand because the real state root cannot produce the case that matters: all 105 mirror subtrees on
// this machine are the modern `<slug>-<uid>` form, so the bare-`<uid>` branch never runs against live data
// and an implementation that only matched exact names would look perfectly healthy here — and would silently
// migrate nothing for a peer still writing the legacy form.
describe("the SDL mirror leg is found by repoUid SUFFIX, not by directory name", () => {
  const UID = "0123456789abcdef0123456789abcdef01234567";

  /** A state root with one repo, one SDL, and (optionally) one mirror subtree spelled `subtreeName`. */
  const build = (subtreeName: string | null): { stateDir: string; sdlDir: string } => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-area4-state-"));
    const sdlDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-area4-sdl-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-area4-work-"));

    fs.mkdirSync(path.join(stateDir, "pin", "r", "somefolder"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "pin", "r", "somefolder", "config.yaml"),
      `schema_version: 1\nrepo:\n  name: work\n  path: ${repoDir}\n  remote: null\n`,
    );
    // The tracking dir resolves by KEY SUFFIX too (`keyed-dir.ts isDirForKey`), so the slug in front of the
    // key is arbitrary — the same rule, one level up.
    const trackingDir = path.join(stateDir, "repos", `work-${repoKeyFor(repoDir)}`);
    fs.mkdirSync(trackingDir, { recursive: true });
    fs.writeFileSync(path.join(trackingDir, "decisions.yaml"), "schema_version: 1\nevents: []\n");
    fs.writeFileSync(path.join(trackingDir, ".sync-repo"), `${sdlDir}\n${UID}\nwork\n`);

    if (subtreeName !== null) {
      const sub = path.join(sdlDir, "repos", subtreeName);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, "decisions.yaml"), "schema_version: 1\nevents: []\n");
    }
    return { stateDir, sdlDir };
  };

  const legsFor = (stateDir: string): string[] => {
    const prior = process.env.LFB_STATE_DIR;
    const priorMode = process.env.LFB_DB_MODE;
    process.env.LFB_STATE_DIR = stateDir;
    process.env.LFB_DB_MODE = "off"; // R2 in miniature: scope discovery is a pure filesystem walk
    try {
      const scope = decisionScopes().find((s) => s.key === "r/somefolder");
      return ((scope?.data as { legs?: { key: string }[] } | undefined)?.legs ?? []).map((l) => l.key);
    } finally {
      if (prior === undefined) delete process.env.LFB_STATE_DIR;
      else process.env.LFB_STATE_DIR = prior;
      if (priorMode === undefined) delete process.env.LFB_DB_MODE;
      else process.env.LFB_DB_MODE = priorMode;
    }
  };

  it("matches the modern <slug>-<uid> subtree", () => {
    const { stateDir, sdlDir } = build(`work-${UID}`);
    expect(legsFor(stateDir)).toEqual(["local", path.basename(sdlDir)]);
  });

  it("matches the LEGACY bare-<uid> subtree, which no live directory on this machine exercises", () => {
    const { stateDir, sdlDir } = build(UID);
    expect(legsFor(stateDir)).toEqual(["local", path.basename(sdlDir)]);
  });

  it("finds only the local leg when the SDL holds no subtree for this uid", () => {
    const { stateDir } = build(null);
    expect(legsFor(stateDir)).toEqual(["local"]);
  });

  it("finds only the local leg when a same-length directory is NOT this uid", () => {
    // The suffix rule must not degrade into "any directory of about the right shape": a different repo's
    // subtree living beside ours would otherwise donate its events to our unit.
    const { stateDir } = build(`work-${"f".repeat(40)}`);
    expect(legsFor(stateDir)).toEqual(["local"]);
  });
});
