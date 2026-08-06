// SIDECARS AND HISTORY LOGS ARE SHARED APPEND-ONLY STATE TOO (repo_tracking_scheme.mdx §3.2/§4).
//
// `manifest.yaml`, `decisions.yaml` and `repo_storage.yaml` each got a real merge after entries were
// measured going missing. The per-file `files/<rel>.yaml` sidecars and the per-device `history/<device>.txt`
// logs did NOT — tracking-sync.service.ts copied them with a bare `fs.copyFileSync` in both directions and
// its header called that "safe for those shapes".
//
// It is not. `appendFileEvent` writes Local Storage and does not mirror; the mirror refreshes only on
// `writeRepoStorage` / `writeRepoTrackingManifest`, while `reconcileFromSyncRepo` runs on EVERY backbone
// pull. So the inbound copy routinely landed on events written since the last mirror — including the
// `pull` + `ipfs_pin` events `pullMissing` writes the moment a file's bytes arrive.
//
// These tests pin the three properties that make the copy safe: nothing is lost from either side, the
// result is the SAME on both computers (or each one's merge re-dirties what the other wrote and the
// backbone commits forever — git_backbone.mdx §6.6), and an unchanged file is not rewritten at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import YAML from "yaml";
import { copyTrackedFile, isSidecarPath, isHistoryPath } from "./tracked-file-merge.js";

const TOWER = "bryan-mac-pro";
const LAPTOP = "nayan-desktop-tqau7t7";
const CLIP = "jfk/training/clip.mp4";

let dir: string;
const roots: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-tracked-merge-"));
  roots.push(dir);
});
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

// ── sidecars ────────────────────────────────────────────────────────────────────────────────────────

interface Ev {
  at: string;
  kind: string;
  on_device: string;
  by?: string | null;
}
const sidecar = (events: Ev[], over: Record<string, unknown> = {}): string =>
  YAML.stringify(
    {
      file: {
        path: CLIP,
        name: "clip.mp4",
        categories: ["large", "video"],
        size: 100,
        hash: null,
        modified: "2026-08-05T00:00:00.000Z",
        first_seen: { at: "2026-08-01T00:00:00.000Z", on_device: TOWER },
        events,
        ...over,
      },
    },
    { sortMapEntries: true },
  );

const ev = (at: string, kind: string, on_device: string): Ev => ({ at, kind, on_device, by: null });

/** Write both sides, merge src→dst, and return the resulting `file:` block. */
function mergeSidecar(localText: string, incomingText: string): Record<string, unknown> {
  const local = path.join(dir, "local.yaml");
  const incoming = path.join(dir, "incoming.yaml");
  fs.writeFileSync(local, localText);
  fs.writeFileSync(incoming, incomingText);
  copyTrackedFile(incoming, local, `files/${CLIP}.yaml`);
  return (YAML.parse(fs.readFileSync(local, "utf8")) as { file: Record<string, unknown> }).file;
}

describe("sidecar merge — a copy must never delete the other computer's events", () => {
  it("keeps events only this computer has AND events only the peer has", () => {
    // The live shape: the laptop pulled a file (two local events) while the tower described it (one event
    // that reached the mirror). The old copy kept exactly one side.
    const mine = [ev("2026-08-05T10:00:00.000Z", "pull", LAPTOP), ev("2026-08-05T10:00:01.000Z", "ipfs_pin", LAPTOP)];
    const theirs = [ev("2026-08-05T09:00:00.000Z", "observed", TOWER)];
    const merged = mergeSidecar(sidecar(mine), sidecar(theirs));
    const kinds = (merged.events as Ev[]).map((e) => `${e.kind}@${e.on_device}`);
    expect(kinds).toEqual(["observed@" + TOWER, "pull@" + LAPTOP, "ipfs_pin@" + LAPTOP]);
  });

  it("collapses an exact re-send instead of growing the list without bound", () => {
    const shared = [ev("2026-08-05T09:00:00.000Z", "observed", TOWER)];
    expect(mergeSidecar(sidecar(shared), sidecar(shared)).events).toHaveLength(1);
  });

  it("is SYMMETRIC — both computers land on identical bytes", () => {
    // The property that stops the ping-pong: merge(A,B) must equal merge(B,A), or each machine's write
    // re-dirties the other's and every cycle produces a commit.
    const a = sidecar([ev("2026-08-05T10:00:00.000Z", "pull", LAPTOP)], { size: 200, modified: "2026-08-05T02:00:00.000Z" });
    const b = sidecar([ev("2026-08-05T09:00:00.000Z", "observed", TOWER)], { size: 100, modified: "2026-08-05T01:00:00.000Z" });
    expect(YAML.stringify(mergeSidecar(a, b), { sortMapEntries: true })).toBe(
      YAML.stringify(mergeSidecar(b, a), { sortMapEntries: true }),
    );
  });

  it("takes the EARLIEST first_seen, so the field converges instead of ping-ponging", () => {
    const early = sidecar([], { first_seen: { at: "2026-07-01T00:00:00.000Z", on_device: TOWER } });
    const late = sidecar([], { first_seen: { at: "2026-08-01T00:00:00.000Z", on_device: LAPTOP } });
    expect((mergeSidecar(late, early).first_seen as Ev).at).toBe("2026-07-01T00:00:00.000Z");
    expect((mergeSidecar(early, late).first_seen as Ev).at).toBe("2026-07-01T00:00:00.000Z");
  });

  it("takes the identity block whole from the side with the newer `modified`", () => {
    // Never field-by-field: a `size` from one computer beside a `hash` from another describes a file that
    // never existed.
    const older = sidecar([], { size: 100, hash: "sha-old", modified: "2026-08-01T00:00:00.000Z" });
    const newer = sidecar([], { size: 250, hash: "sha-new", modified: "2026-08-06T00:00:00.000Z" });
    const merged = mergeSidecar(older, newer);
    expect(merged.size).toBe(250);
    expect(merged.hash).toBe("sha-new");
  });

  it("does not rewrite a file whose merge changes nothing", () => {
    // A no-op rewrite would re-dirty the mirror on every pass and manufacture a commit per cycle.
    // Backdated so the assertion cannot pass merely because a real rewrite landed in the same millisecond.
    const local = path.join(dir, "local.yaml");
    const incoming = path.join(dir, "incoming.yaml");
    const text = sidecar([ev("2026-08-05T09:00:00.000Z", "observed", TOWER)]);
    fs.writeFileSync(local, text);
    fs.writeFileSync(incoming, text);
    const past = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(local, past, past);
    copyTrackedFile(incoming, local, `files/${CLIP}.yaml`);
    expect(fs.statSync(local).mtime.toISOString()).toBe(past.toISOString());
  });

  it("keeps the destination when the incoming copy is unreadable, and replaces an unreadable destination", () => {
    // Least-loss both ways: never clobber good with bad, but do replace garbage with something valid.
    const local = path.join(dir, "local.yaml");
    const incoming = path.join(dir, "incoming.yaml");
    const good = sidecar([ev("2026-08-05T09:00:00.000Z", "observed", TOWER)]);

    fs.writeFileSync(local, good);
    fs.writeFileSync(incoming, "\t: not: yaml: [");
    copyTrackedFile(incoming, local, `files/${CLIP}.yaml`);
    expect(fs.readFileSync(local, "utf8")).toBe(good);

    fs.writeFileSync(local, "\t: not: yaml: [");
    fs.writeFileSync(incoming, good);
    copyTrackedFile(incoming, local, `files/${CLIP}.yaml`);
    expect(fs.readFileSync(local, "utf8")).toBe(good);
  });
});

// ── history logs ────────────────────────────────────────────────────────────────────────────────────

const HEADER = `# Large File Bridge — history log for computer "${TOWER}" · repo demo\n# All timestamps UTC. Append-only.\n`;

function mergeHistory(localText: string, incomingText: string): string {
  const local = path.join(dir, `${TOWER}.txt`);
  const incoming = path.join(dir, `incoming-${TOWER}.txt`);
  fs.writeFileSync(local, localText);
  fs.writeFileSync(incoming, incomingText);
  copyTrackedFile(incoming, local, `history/${TOWER}.txt`);
  return fs.readFileSync(local, "utf8");
}

describe("history merge — the log is append-only, so a copy must not truncate it", () => {
  it("unions both sides' entries and keeps them in timestamp order", () => {
    const mine = `${HEADER}2026-08-05T10:00:00.000Z  PULL  Pulled clip.mp4 down over IPFS\n`;
    const theirs = `${HEADER}2026-08-05T09:00:00.000Z  DECISION  Marked clip.mp4 for sync\n`;
    const out = mergeHistory(mine, theirs);
    expect(out).toContain("DECISION");
    expect(out).toContain("PULL");
    expect(out.indexOf("DECISION")).toBeLessThan(out.indexOf("PULL"));
  });

  it("keeps an indented per-file breakdown attached to the entry it explains", () => {
    // Unioning by BARE LINES would let a repeated `pin=yes  path` line be deduped away from its parent, or
    // re-attached under the wrong one. Blocks are the unit.
    const block = `2026-08-05T09:00:00.000Z  DECISION  Decided 2 files\n${" ".repeat(24)}pin=yes  a.mp4\n${" ".repeat(24)}pin=yes  b.mp4\n`;
    const out = mergeHistory(`${HEADER}${block}`, `${HEADER}2026-08-05T10:00:00.000Z  SCAN  Scanned\n`);
    expect(out).toContain(`Decided 2 files\n${" ".repeat(24)}pin=yes  a.mp4\n${" ".repeat(24)}pin=yes  b.mp4`);
  });

  it("is SYMMETRIC and emits the banner exactly once", () => {
    const a = `${HEADER}2026-08-05T10:00:00.000Z  PULL  one\n`;
    const b = `${HEADER}2026-08-05T09:00:00.000Z  SCAN  two\n`;
    expect(mergeHistory(a, b)).toBe(mergeHistory(b, a));
    expect(mergeHistory(a, b).match(/# Large File Bridge/g)).toHaveLength(1);
  });

  it("does not rewrite a log the peer's copy adds nothing to", () => {
    const local = path.join(dir, `${TOWER}.txt`);
    const incoming = path.join(dir, `incoming-${TOWER}.txt`);
    const text = `${HEADER}2026-08-05T10:00:00.000Z  PULL  one\n`;
    fs.writeFileSync(local, text);
    fs.writeFileSync(incoming, text);
    const past = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(local, past, past);
    copyTrackedFile(incoming, local, `history/${TOWER}.txt`);
    expect(fs.statSync(local).mtime.toISOString()).toBe(past.toISOString());
  });
});

// ── routing ─────────────────────────────────────────────────────────────────────────────────────────

describe("shape routing — only the two append-only shapes are merged", () => {
  it("recognises sidecars and history logs by their state-dir-relative path", () => {
    expect(isSidecarPath("files/a/b/clip.mp4.yaml")).toBe(true);
    expect(isSidecarPath("manifest.yaml")).toBe(false);
    expect(isHistoryPath(`history/${TOWER}.txt`)).toBe(true);
    expect(isHistoryPath("files/clip.mp4.yaml")).toBe(false);
  });

  it("plain-copies any other shape, exactly as before", () => {
    const local = path.join(dir, "other.yaml");
    const incoming = path.join(dir, "other-in.yaml");
    fs.writeFileSync(local, "old: 1\n");
    fs.writeFileSync(incoming, "new: 2\n");
    copyTrackedFile(incoming, local, "compression/record.yaml");
    expect(fs.readFileSync(local, "utf8")).toBe("new: 2\n");
  });

  it("plain-copies when the destination does not exist yet", () => {
    const incoming = path.join(dir, "in.yaml");
    fs.writeFileSync(incoming, sidecar([]));
    copyTrackedFile(incoming, path.join(dir, "fresh.yaml"), `files/${CLIP}.yaml`);
    expect(fs.existsSync(path.join(dir, "fresh.yaml"))).toBe(true);
  });
});

// ── the two real copy legs ──────────────────────────────────────────────────────────────────────────
//
// The unit tests above prove the merge; these prove it is actually WIRED into both directions of the
// sync-repo mirror. A merge nobody calls is exactly the shape of the original defect — `reconcileFromSyncRepo`
// shipped with a real merge and ZERO callers, so a mirrored manifest that did arrive was never folded in.
describe("mirror + reconcile — neither leg may stamp over the other side's events", () => {
  const REMOTE = "https://github.com/ACT3ai/all.git";
  let stateDir: string;
  let repoRoot: string;
  let syncRepo: string;
  let mirrorDir: string;
  let localDir: string;
  let prevStateDir: string | undefined;
  let mirrorToSyncRepo: (root: string) => boolean;
  let reconcileFromSyncRepo: (root: string) => boolean;

  const localSidecar = (): string => path.join(localDir, "files", `${CLIP}.yaml`);
  const mirrorSidecar = (): string => path.join(mirrorDir, "files", `${CLIP}.yaml`);
  const write = (file: string, body: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const eventsIn = (file: string): string[] =>
    ((YAML.parse(fs.readFileSync(file, "utf8")) as { file: { events: Ev[] } }).file.events ?? []).map(
      (e) => `${e.kind}@${e.on_device}`,
    );

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-tfm-state-"));
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-tfm-repo-"));
    syncRepo = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-tfm-sync-"));
    roots.push(stateDir, repoRoot, syncRepo);
    // Own state root, SAVED AND RESTORED — the vitest baseline root is shared between spec files.
    prevStateDir = process.env.LFB_STATE_DIR;
    process.env.LFB_STATE_DIR = stateDir;

    const mod = await import("./tracking-sync.service.js");
    const { repoStateDir, resolveStateSyncRepo } = await import("./tracking-root.service.js");
    mirrorToSyncRepo = mod.mirrorToSyncRepo;
    reconcileFromSyncRepo = mod.reconcileFromSyncRepo;
    mod.setSyncRepoMarker(repoRoot, syncRepo, REMOTE);
    mirrorDir = resolveStateSyncRepo(repoRoot)!;
    localDir = repoStateDir(repoRoot);
  });

  afterAll(() => {
    if (prevStateDir === undefined) delete process.env.LFB_STATE_DIR;
    else process.env.LFB_STATE_DIR = prevStateDir;
  });

  it("OUTBOUND: the mirror keeps a peer event the merge delivered but this computer has not reconciled", () => {
    // The precise live ordering: a deferred mirror drains in `pull()`'s finally — AFTER git merged the
    // peer's sidecar into the mirror, BEFORE `reconcileMirroredRepos` folds it into Local Storage. The old
    // wholesale copy stamped this machine's copy over it and the backbone PUSHED the loss.
    write(mirrorSidecar(), sidecar([ev("2026-08-05T09:00:00.000Z", "observed", TOWER)]));
    write(localSidecar(), sidecar([ev("2026-08-05T10:00:00.000Z", "pull", LAPTOP)]));

    expect(mirrorToSyncRepo(repoRoot)).toBe(true);
    expect(eventsIn(mirrorSidecar())).toEqual([`observed@${TOWER}`, `pull@${LAPTOP}`]);
  });

  it("INBOUND: the reconcile keeps a local event written since the last mirror", () => {
    // `appendFileEvent` writes Local Storage and does NOT mirror, while the reconcile runs on every backbone
    // pull — so local events routinely predate their trip to the mirror. They must survive the return leg.
    write(mirrorSidecar(), sidecar([ev("2026-08-05T09:00:00.000Z", "observed", TOWER)]));
    write(localSidecar(), sidecar([ev("2026-08-05T11:00:00.000Z", "ipfs_pin", LAPTOP)]));

    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
    expect(eventsIn(localSidecar())).toEqual([`observed@${TOWER}`, `ipfs_pin@${LAPTOP}`]);
  });

  it("INBOUND: a history log is unioned, not truncated to the peer's copy", () => {
    const log = `history/${TOWER}.txt`;
    write(path.join(mirrorDir, log), `${HEADER}2026-08-05T09:00:00.000Z  SCAN  from the mirror\n`);
    write(path.join(localDir, log), `${HEADER}2026-08-05T11:00:00.000Z  PULL  written locally since\n`);

    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
    const out = fs.readFileSync(path.join(localDir, log), "utf8");
    expect(out).toContain("from the mirror");
    expect(out).toContain("written locally since");
  });
});
