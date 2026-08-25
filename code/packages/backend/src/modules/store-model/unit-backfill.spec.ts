// THE TWO TRANSFORMS THAT ARE EASY TO GET BACKWARDS (database_migration.mdx §4.4).
//
// Both are pure functions here on purpose: each one is a single expression whose WRONG version is silent,
// produces no error, and is only discovered later as "the fleet stopped syncing" or "this computer's pins
// are attributed to a machine that does not exist".
//
// The third block at the bottom of this file is the one case the real state root cannot produce — a legacy
// one-line `.sync-repo` marker — and it is built by hand for exactly that reason.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ADOPT_UNITS, mirrorOptoutFor, canonicalDeviceLabel, indexDeviceRegistry } from "./unit-backfill.js";
import { copyRows, exec, q } from "../../shared/persistence/db.js";
import { repoKeyFor } from "../storage/tracking-root.service.js";

describe("the tri-state opt-out — getting this backwards opts EVERY repo out", () => {
  it("maps absent -> NULL, false -> true, true -> false", () => {
    // ABSENT is the case that matters. `sync_repo.enabled` is optional, not defaulted (schemas.ts:541),
    // because the mirror is ON by default and the toggle is an OPT-OUT. All 105 repo configs on this machine
    // carry `sync_repo: {}` — every one of them predates the feature — so a mapping that read absent as
    // "opted out" would stop the entire fleet mirroring and nothing would say why.
    expect(mirrorOptoutFor(undefined)).toBeNull();
    expect(mirrorOptoutFor(false)).toBe(true);
    expect(mirrorOptoutFor(true)).toBe(false);
  });
});

describe("device spellings — one computer must not become two rows", () => {
  // `history/<device>.txt` filenames are repoFolderKey-SANITIZED; `pinned_by` labels are not. The SDL device
  // registry is what tells us the two are one computer, and it has to be consulted BEFORE ids are assigned:
  // once two rows exist, `is_self` is on at most one of them and `pinned_here` is wrong for the other forever.
  const reg = indexDeviceRegistry([
    { fileStem: "bryan-mac-pro", name: "bryan-mac-pro", peerId: "12D3KooWaaa" },
    { fileStem: "nayan-neo", name: "nayan-neo", peerId: "12D3KooWbbb" },
    // A computer whose declared name is NOT its filename spelling — the case the sanitizer creates.
    { fileStem: "xmod2-sjoshi", name: "xmod2 sjoshi", peerId: "12D3KooWccc" },
  ]);

  it("resolves a history FILENAME to the registry's declared name", () => {
    expect(canonicalDeviceLabel("nayan-neo", reg)).toEqual({ label: "nayan-neo", peerId: "12D3KooWbbb" });
  });

  it("collapses the sanitized filename and the unsanitized label onto ONE canonical name", () => {
    // Both spellings of the same computer must land on the same label, or it gets two device rows.
    expect(canonicalDeviceLabel("xmod2 sjoshi", reg).label).toBe("xmod2 sjoshi");
    expect(canonicalDeviceLabel("xmod2-sjoshi", reg).label).toBe("xmod2 sjoshi");
  });

  it("keeps a label the registry has never heard of, rather than inventing a match", () => {
    // `nayan-desktop-tqau7t7` is a real `pinned_by` label on this machine with no device file. Guessing that
    // it is `nayan-neo` because the prefixes rhyme would merge two computers on a hunch; the registry is the
    // authority on what is one computer, and where it is silent so are we.
    expect(canonicalDeviceLabel("nayan-desktop-tqau7t7", reg)).toEqual({
      label: "nayan-desktop-tqau7t7",
      peerId: null,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE LEGACY ONE-LINE `.sync-repo` MARKER
//
// This is the ONE named assertion in area 2 that the real corpus cannot exercise: all 105 tracking dirs on
// this machine carry a full three-line marker, so the live backfill reports zero rejects and the branch that
// refuses a uid-less marker never runs. Untested, it would be indistinguishable from a branch that silently
// accepted one — and accepting one means writing `sync_repo_id` for a repo whose mirror subtree can never be
// located (`resolveStateSyncRepo` already returns null for it), i.e. a row that claims a mirror that is not
// there. So the case is built by hand.
//
// It runs with NO DATABASE on purpose (`LFB_DB_MODE=off`): the reject is recorded before any write is
// attempted, which is also a live demonstration of R2 — the area still walks its scopes and still reaches
// its verdict on a machine with no Postgres.
describe("a `.sync-repo` marker with no uid is recorded, never silently accepted", () => {
  const mkStateRoot = (markerLines: string): { stateDir: string; repoDir: string } => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-area2-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-work-"));
    fs.mkdirSync(path.join(stateDir, "pin", "r", "somefolder"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "pin", "r", "somefolder", "config.yaml"),
      `schema_version: 1\nrepo:\n  name: work\n  path: ${repoDir}\n  remote: null\n`,
    );
    // The tracking dir is found by KEY SUFFIX (`keyed-dir.ts isDirForKey`), never by exact name — the same
    // rule the mirror match uses, which is why the slug in front of the key is arbitrary here.
    const dir = path.join(stateDir, "repos", `work-${repoKeyFor(repoDir)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".sync-repo"), markerLines);
    return { stateDir, repoDir };
  };

  const runArea2 = async (stateDir: string): Promise<Array<{ path: string; reason: string }>> => {
    const priorState = process.env.LFB_STATE_DIR;
    const priorMode = process.env.LFB_DB_MODE;
    process.env.LFB_STATE_DIR = stateDir;
    process.env.LFB_DB_MODE = "off";
    try {
      const scopes = await ADOPT_UNITS.scopes();
      const scope = scopes.find((s) => s.key === "r/somefolder")!;
      const rejects: Array<{ path: string; reason: string }> = [];
      await ADOPT_UNITS.run(scope, {
        scope,
        resumeFrom: null,
        rowsBefore: 0,
        q,
        exec,
        copyRows,
        reject: (p, reason) => rejects.push({ path: p, reason }),
        checkpoint: () => {},
      });
      return rejects;
    } finally {
      if (priorState === undefined) delete process.env.LFB_STATE_DIR;
      else process.env.LFB_STATE_DIR = priorState;
      if (priorMode === undefined) delete process.env.LFB_DB_MODE;
      else process.env.LFB_DB_MODE = priorMode;
    }
  };

  it("rejects the uid-less marker, naming the file, and does not abort the scope", async () => {
    const { stateDir } = mkStateRoot("/Users/somebody/BGit/act3/act3_large_files_bridge\n");
    const rejects = await runArea2(stateDir);
    expect(rejects).toHaveLength(1);
    expect(rejects[0].path).toMatch(/\.sync-repo$/);
    expect(rejects[0].reason).toContain("legacy .sync-repo marker");
  });

  it("accepts a full three-line marker with no reject at all", async () => {
    const { stateDir } = mkStateRoot(
      "/Users/somebody/BGit/act3/act3_large_files_bridge\n0123456789abcdef0123456789abcdef01234567\nwork\n",
    );
    expect(await runArea2(stateDir)).toEqual([]);
  });
});
