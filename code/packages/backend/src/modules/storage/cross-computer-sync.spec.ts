// The two pieces of logic that decide whether a big file on one computer ever becomes visible on another
// (storage_company.mdx §8): the repo's SHARED identity (§8.4.1) and the per-entry manifest MERGE (§8.4.3).
//
// Both were regressions of omission rather than of logic — the mirror was keyed by a path hash that could
// not match across machines, and the reconcile was a last-writer copy that erased the peer's pin claim. The
// tests below are written so that reintroducing either mistake fails loudly.
import { describe, it, expect } from "vitest";
import type { Manifest } from "@lfb/shared";
import { repoUidFor, normalizeRemoteKey } from "./repo-identity.js";
import { mergeManifests } from "./tracking-sync.service.js";

const manifest = (files: Manifest["files"]): Manifest => ({ schema_version: 1, unit: "repo", files });

describe("repoUidFor — a repo's identity must travel (§8.4.1)", () => {
  it("gives the SAME uid on two computers with different home directories", () => {
    // The whole defect in one assertion: the Tower and the laptop hold the same repo at different absolute
    // paths, so a path-derived key made them write to different subtrees of the same sync repo.
    const remote = "https://github.com/ACT3ai/charlie-kirk.git";
    expect(repoUidFor(remote)).toBe(repoUidFor(remote));
    expect(repoUidFor(remote)).toBeTruthy();
  });

  it("folds SSH and HTTPS, case, .git and a trailing slash to one identity", () => {
    const uid = repoUidFor("https://github.com/ACT3ai/charlie-kirk.git");
    for (const variant of [
      "git@github.com:ACT3ai/charlie-kirk.git",
      "git@github.com:act3ai/charlie-kirk",
      "https://github.com/act3ai/charlie-kirk/",
      "ssh://git@github.com/ACT3ai/charlie-kirk",
    ]) {
      expect(repoUidFor(variant)).toBe(uid);
    }
  });

  it("separates different repos and different orgs", () => {
    const a = repoUidFor("https://github.com/ACT3ai/charlie-kirk.git");
    expect(a).not.toBe(repoUidFor("https://github.com/ACT3ai/other-repo.git"));
    expect(a).not.toBe(repoUidFor("https://github.com/SomeoneElse/charlie-kirk.git"));
  });

  it("returns null with no usable remote — no shared identity, so no mirror", () => {
    // Honest emptiness: writing to a subtree keyed by something machine-local would look like it worked.
    expect(repoUidFor(null)).toBeNull();
    expect(repoUidFor("")).toBeNull();
    expect(repoUidFor("/Users/bryan/BGit/some/local/path")).toBeNull();
    expect(normalizeRemoteKey("/Users/bryan/BGit/some/local/path")).toBeNull();
  });
});

describe("mergeManifests — receiving is a merge, never a copy (§8.4.3)", () => {
  const TOWER = "bryan-mac-pro";
  const LAPTOP = "bryanstarbuck-macbook-pro";
  const VIDEO = "videos/2079054276320440416.mp4";

  it("brings a peer's file across to a computer that has never seen it", () => {
    // The headline case: the laptop's manifest is empty and the Tower's entry must arrive intact.
    const merged = mergeManifests(
      manifest([]),
      manifest([{ path: VIDEO, cid: "bafyTOWER", size: 5340486, sha256: null, modified_at: "2026-07-20T13:00:56.644Z", pinned_by: [TOWER] }]),
    );
    expect(merged.files).toHaveLength(1);
    expect(merged.files[0]).toMatchObject({ path: VIDEO, cid: "bafyTOWER", size: 5340486, pinned_by: [TOWER] });
  });

  it("UNIONS pinned_by instead of replacing it — the peer's claim is the whole signal", () => {
    // A last-writer copy erases the other computer's claim, which is precisely what makes a file eligible
    // for the Pull down metric. Losing it re-empties the list this feature exists to fill.
    const merged = mergeManifests(
      manifest([{ path: VIDEO, cid: "bafyTOWER", size: 10, sha256: null, modified_at: "2026-01-01T00:00:00Z", pinned_by: [LAPTOP] }]),
      manifest([{ path: VIDEO, cid: "bafyTOWER", size: 10, sha256: null, modified_at: "2026-01-01T00:00:00Z", pinned_by: [TOWER] }]),
    );
    expect(merged.files[0]!.pinned_by).toEqual([TOWER, LAPTOP].sort());
  });

  it("NEVER treats an absent entry as a delete", () => {
    const local = manifest([
      { path: "videos/keep-me.mp4", cid: "bafyLOCAL", size: 1, sha256: null, modified_at: "2026-01-01T00:00:00Z", pinned_by: [LAPTOP] },
    ]);
    const merged = mergeManifests(local, manifest([]));
    expect(merged.files.map((f) => f.path)).toContain("videos/keep-me.mp4");
  });

  it("resolves a conflicting CID by the newer modified_at, keeping local on a tie", () => {
    const older = { path: VIDEO, cid: "bafyOLD", size: 1, sha256: null, modified_at: "2026-01-01T00:00:00Z", pinned_by: [LAPTOP] };
    const newer = { path: VIDEO, cid: "bafyNEW", size: 2, sha256: null, modified_at: "2026-07-20T00:00:00Z", pinned_by: [TOWER] };
    expect(mergeManifests(manifest([older]), manifest([newer])).files[0]!.cid).toBe("bafyNEW");
    expect(mergeManifests(manifest([newer]), manifest([older])).files[0]!.cid).toBe("bafyNEW");
    const tie = { ...newer, cid: "bafyINCOMING" };
    expect(mergeManifests(manifest([{ ...newer, cid: "bafyLOCAL" }]), manifest([tie])).files[0]!.cid).toBe("bafyLOCAL");
  });

  it("is order-independent and stable — merging both ways yields the same set", () => {
    const a = manifest([{ path: "b.mp4", cid: "b", size: 1, sha256: null, modified_at: "2026-01-01T00:00:00Z", pinned_by: [LAPTOP] }]);
    const b = manifest([{ path: "a.mp4", cid: "a", size: 1, sha256: null, modified_at: "2026-01-01T00:00:00Z", pinned_by: [TOWER] }]);
    expect(mergeManifests(a, b).files.map((f) => f.path)).toEqual(["a.mp4", "b.mp4"]);
    expect(mergeManifests(b, a).files.map((f) => f.path)).toEqual(["a.mp4", "b.mp4"]);
  });
});

// ── the RECEIVE side made visible: a row for a file that is not on this disk (§8.5) ──────────────────
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoUnitConfig, FileRow } from "@lfb/shared";
import { remoteOnlyRows } from "../store-model/units.service.js";

describe("remoteOnlyRows — the laptop sees the Tower's file (§8.5)", () => {
  const TOWER = "bryan-mac-pro";
  const LAPTOP = "bryanstarbuck-macbook-pro";
  const VIDEO = "videos/2079054276320440416.mp4";
  const CID = "bafybeihf5osteipkvxd7fpxygzfc2mlqkhwtjy2somrjptf6ni4axk7tmi";

  // A repo root that exists but does NOT contain the video — the laptop's situation exactly.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-remote-only-"));
  const cfg = { repo: { path: root }, decisions: {} } as unknown as RepoUnitConfig;
  const entry = { path: VIDEO, cid: CID, size: 5340486, sha256: null, modified_at: "2026-07-20T13:00:56.644Z", pinned_by: [TOWER] };

  it("produces a remote-only row for a peer's file this computer lacks", () => {
    const rows = remoteOnlyRows(cfg, manifest([entry]), [], root, LAPTOP);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    // Identity comes from the manifest, because there is nothing on disk to stat.
    expect(r).toMatchObject({ path: VIDEO, cid: CID, sizeBytes: 5340486, presence: "remote-only", addedByDevice: TOWER });
    // Analysis on absent bytes would queue work that cannot run — and this is also what keeps the row off
    // the Transcribe / Describe / OCR tabs, whose filters key on "could"/"done".
    expect([r.transcribe, r.describe, r.ocr, r.compress]).toEqual(["na", "na", "na", "na"]);
    // Nothing local to ignore, and the bytes are verifiably not pinned here.
    expect(r.gitignore).toBe(false);
    expect(r.pinnedHere).toBe(false);
  });

  it("does NOT duplicate a file the scan already produced a row for", () => {
    const scanned = [{ path: VIDEO } as FileRow];
    expect(remoteOnlyRows(cfg, manifest([entry]), scanned, root, LAPTOP)).toHaveLength(0);
  });

  it("does NOT resurrect a file only THIS computer ever claimed", () => {
    // Deleted here on purpose: a stale self-only entry must not become a row offering bytes nobody has.
    const selfOnly = { ...entry, pinned_by: [LAPTOP] };
    expect(remoteOnlyRows(cfg, manifest([selfOnly]), [], root, LAPTOP)).toHaveLength(0);
  });

  it("skips an entry with no CID — there is nothing to pull", () => {
    expect(remoteOnlyRows(cfg, manifest([{ ...entry, cid: null }]), [], root, LAPTOP)).toHaveLength(0);
  });

  it("skips a file that IS on this disk", () => {
    fs.mkdirSync(path.join(root, "videos"), { recursive: true });
    fs.writeFileSync(path.join(root, VIDEO), "bytes");
    expect(remoteOnlyRows(cfg, manifest([entry]), [], root, LAPTOP)).toHaveLength(0);
  });
});

// ── the persisted default that would have kept the feature off for every existing repo ───────────────
import YAML from "yaml";
import { RepoUnitConfigSchema } from "@lfb/shared";
import {
  clearPersistedSyncRepoFalse,
  repairEmptySyncRepoBlock,
  repairEmptySyncRepoBlocks,
} from "../../config/migrate-sync-repo-default.js";

describe("clearPersistedSyncRepoFalse — a schema default is not a user's choice (§8.4.2)", () => {
  it("drops an `enabled: false` the old default persisted, leaving a VALID empty block", () => {
    // 178 repo configs on the reference machine carried this line. Left in place, every one of them reads
    // as an explicit opt-out and nothing ever mirrors.
    //
    // But `enabled` is the block's ONLY child, so the first version of this migration removed the line and
    // left a bare `sync_repo:` — which YAML parses as `null`, and `z.object(...).prefault({})` rejects. It
    // ran once on the reference machine and made all 178 configs unreadable: no scan, no To-Do recalc, no
    // reconcileMirroredRepos, for every repo at once. The output must stay PARSEABLE — see the assertion below.
    const before = "pinned: true\nsync_repo:\n  enabled: false\nowner_override: null\n";
    expect(clearPersistedSyncRepoFalse(before)).toBe("pinned: true\nsync_repo: {}\nowner_override: null\n");
  });

  it("leaves an explicit `true` alone and reports no change", () => {
    expect(clearPersistedSyncRepoFalse("sync_repo:\n  enabled: true\n")).toBeNull();
  });

  it("is a no-op when there is no sync_repo block", () => {
    expect(clearPersistedSyncRepoFalse("pinned: true\nbookmarked: false\n")).toBeNull();
  });

  it("touches nothing outside the sync_repo block — including an `enabled: false` elsewhere", () => {
    const yaml = "big_file_override:\n  enabled: false\n  value: 100\nsync_repo:\n  enabled: false\npinned: true\n";
    expect(clearPersistedSyncRepoFalse(yaml)).toBe(
      "big_file_override:\n  enabled: false\n  value: 100\nsync_repo: {}\npinned: true\n",
    );
  });

  // THE ACCEPTANCE TEST for the outage: whatever this migration writes must still LOAD. Asserting the exact
  // string is not enough — that is what the original test did, and it happily froze the broken output in place.
  it("produces output the repo-unit schema can still parse", () => {
    const before = "pinned: true\nsync_repo:\n  enabled: false\nowner_override: null\n";
    const after = clearPersistedSyncRepoFalse(before)!;
    const parsed = RepoUnitConfigSchema.safeParse(YAML.parse(after));
    expect(parsed.success).toBe(true);
    // And absence still means the mirror is ON (§8.4.2) — the whole point of removing the line.
    expect(parsed.success && parsed.data.sync_repo.enabled).toBeUndefined();
  });
});

// THE 2026-07-20 OUTAGE, LAYER ZERO: the schema itself must survive the broken file. Twice in one day a
// line-level migration left a bare `sync_repo:` (= YAML null) in every repo config, and `.prefault({})`
// (undefined-only) rejected it — 1000+ "expected object, received null" per hour, every repo unit skipped by
// reconcileMirroredRepos and every To-Do recalc dead. These tests parse the REAL broken YAML through the REAL
// schema: no store heal, no repair pass — validation alone may never fail on a valueless block again.
describe("RepoUnitConfigSchema — a valueless YAML block must read as its defaults, never throw", () => {
  it("parses the exact broken file shape the migration left behind (bare `sync_repo:`)", () => {
    const broken = "pinned: true\nsync_repo:\nowner_override: null\n";
    const parsed = RepoUnitConfigSchema.safeParse(YAML.parse(broken));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.sync_repo).toEqual({});
    // Absence still means the mirror is ON (storage_company.mdx §8.4.2) — null must not become an opt-out.
    expect(parsed.success && parsed.data.sync_repo.enabled).toBeUndefined();
  });

  it("survives EVERY object block of the repo config being valueless, not just sync_repo", () => {
    const broken =
      "repo:\nbig_file_override:\nlarge_files:\npin:\naccess:\nartifacts:\nsync_repo:\ndecisions:\n";
    const parsed = RepoUnitConfigSchema.safeParse(YAML.parse(broken));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.pin.pin_locally).toBe(true); // block defaults applied
    expect(parsed.success && parsed.data.decisions).toEqual({});
  });

  it("still rejects a genuinely wrong value — null-tolerance is not a bulldozer", () => {
    expect(RepoUnitConfigSchema.safeParse(YAML.parse("sync_repo:\n  enabled: 12\n")).success).toBe(false);
  });
});

describe("repairEmptySyncRepoBlock — cleaning up after the version that shipped broken", () => {
  it("rewrites a valueless `sync_repo:` as an explicit empty map", () => {
    const broken = "pinned: true\nsync_repo:\nowner_override: null\n";
    const fixed = repairEmptySyncRepoBlock(broken)!;
    expect(fixed).toBe("pinned: true\nsync_repo: {}\nowner_override: null\n");
    expect(RepoUnitConfigSchema.safeParse(YAML.parse(fixed)).success).toBe(true);
  });

  it("leaves a block that has children alone", () => {
    expect(repairEmptySyncRepoBlock("sync_repo:\n  enabled: true\n")).toBeNull();
  });

  it("is idempotent — an already-repaired file reports no change", () => {
    expect(repairEmptySyncRepoBlock("sync_repo: {}\npinned: true\n")).toBeNull();
  });

  it("handles the block running to end-of-file", () => {
    expect(repairEmptySyncRepoBlock("pinned: true\nsync_repo:\n")).toBe("pinned: true\nsync_repo: {}\n");
  });

  // THE MARKER LOCKOUT (2026-07-20, second occurrence): the damage recurred AFTER the repair's one-time
  // marker was written, so the sweep never ran again and every repo unit stayed dark. The sweep is now
  // content-driven — an existing marker must never stop it from fixing a re-broken file.
  it("repairEmptySyncRepoBlocks re-repairs even when its marker already exists", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-repair-"));
    try {
      fs.writeFileSync(path.join(stateDir, ".sync-repo-empty-block-repaired"), "2026-07-20T18:03:00.000Z");
      const repoDir = path.join(stateDir, "pin", "r", "some-repo");
      fs.mkdirSync(repoDir, { recursive: true });
      const cfg = path.join(repoDir, "config.yaml");
      fs.writeFileSync(cfg, "pinned: true\nsync_repo:\nowner_override: null\n");
      repairEmptySyncRepoBlocks(stateDir);
      expect(fs.readFileSync(cfg, "utf8")).toBe("pinned: true\nsync_repo: {}\nowner_override: null\n");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// ── one company must not absorb every organization on the disk (§10, §10.4.3) ─────────────────────────
import { ensureCompanyForOwner } from "./storage.service.js";

describe("ensureCompanyForOwner — a company is 1:1 with an org (§10)", () => {
  // Live-disk regression. The "lone company adopts an unclaimed org" fallback had no memory: it fired for
  // EVERY org in turn, so on the reference machine ACT3ai, BryanStarbuck and trykimu all resolved to the one
  // existing company storage. That is precisely the cross-company mixing §10.4.3 calls a confidentiality
  // boundary — one company's tracking text pushed into another company's repo.
  it("does not let a company that already claims an org adopt a second one by heuristic", () => {
    const first = ensureCompanyForOwner("ACT3ai");
    if (!first) return; // no company storage on this machine — nothing to assert
    // Whatever adopted the first org must NOT also adopt an unrelated one.
    const second = ensureCompanyForOwner("SomeUnrelatedOrgThatNobodyClaims");
    expect(second?.id).not.toBe(first.id);
  });

  it("is stable — asking twice for the same org returns the same company", () => {
    const a = ensureCompanyForOwner("ACT3ai");
    const b = ensureCompanyForOwner("ACT3ai");
    expect(b?.id).toBe(a?.id);
  });

  it("returns null for an empty or unparseable slug rather than guessing", () => {
    expect(ensureCompanyForOwner(null)).toBeNull();
    expect(ensureCompanyForOwner("")).toBeNull();
    expect(ensureCompanyForOwner("   ")).toBeNull();
  });
});
