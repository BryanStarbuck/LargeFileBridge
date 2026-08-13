// THE REGRESSION GUARD for the Repos table's cheap counting path (repos.mdx §4.1/§4.2).
//
// `computeRepoRow` deliberately does NOT compose FileRows. A FileRow carries the git-ignore axis (a
// `git check-ignore` spawn per repo) and the four task axes (an artifact probe per file), and none of
// that reaches the Repos table — so the row's counts, peer count and rolled-up status are derived
// straight from the config + scan status + manifest instead. That is what took `GET /api/repos` from an
// ~11-second synchronous handler (which pinned the event loop, so clicking a repo row appeared to do
// nothing) down to well under two seconds on a 179-repo machine.
//
// The risk that buys is DRIFT: two ways to count the same repo can quietly disagree, and then the Repos
// table shows one number while the One-repo page it links to shows another. These tests pin the two
// together — every assertion below compares the row's aggregates against the SAME aggregates recomputed
// from `computeRepoDetail`'s fully-composed rows.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import {
  ManifestSchema,
  UnitStatusSchema,
  type RepoCounts,
  type FileRow,
  type RepoDetail,
  type RepoUnitConfig,
} from "@lfb/shared";
import {
  updateRepoConfig,
  writeRepoStatus,
  writeRepoManifest,
  computeRepoRow,
  computeRepoDetail,
} from "./units.service.js";
import { computerLabel } from "./config.service.js";

const FOLDER = "row-stats-fixture";
// "Pinned" means claimed by THIS computer (ipfs.mdx §1.1), so the fixture must use the label this
// process actually resolves to — a hand-written string would silently make every `sync` row read
// `pending` and the test would pass while proving nothing about the pinned state.
const SELF = computerLabel();
const PEER = "the-tower";

// A repo root that EXISTS but holds none of the manifest's files — so the peer-claimed entries below
// become remote-only rows, which both counting paths have to agree about.
//
// It is a REAL git working tree with a real `.gitignore`, because the git-ignore axis is one of the two
// fields composition defers and patches back in: against a non-repo, `git check-ignore` answers "unknown"
// for everything and the deferral would be exercised only in its empty case.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-row-stats-"));
execFileSync("git", ["init", "-q"], { cwd: root });
fs.writeFileSync(path.join(root, ".gitignore"), "*.mp4\n");

// Distinct sizes on purpose: with every file 1 KB, a byte total that summed the wrong SET of rows would
// still land on a plausible number, and the Size column's whole job is to be the one cell that cannot be
// right by accident.
const candidate = (p: string, analysisOnly = false, size = 1024) => ({
  path: p,
  size,
  modified_at: "2026-07-01T00:00:00Z",
  analysisOnly,
});

const manifestEntry = (p: string, cid: string | null, pinnedBy: string[], size = 1024) => ({
  path: p,
  cid,
  size,
  sha256: null,
  modified_at: "2026-07-01T00:00:00Z",
  pinned_by: pinnedBy,
});

/** The row aggregates recomputed the EXPENSIVE way, from fully-composed FileRows. */
async function aggregatesFromDetail(): Promise<{
  counts: RepoCounts;
  peerCount: number;
  notBackedUp: number;
  missingHere: number;
  bytes: { total: number; pinned: number };
}> {
  const detail = await computeRepoDetail(FOLDER, "unreachable");
  const files: FileRow[] = detail.files;
  const counts: RepoCounts = { pinned: 0, pending: 0, undecided: 0, ignored: 0, pinnedForeign: 0 };
  const peers = new Set<string>();
  const bytes = { total: 0, pinned: 0 };
  let notBackedUp = 0;
  let missingHere = 0;
  for (const f of files) {
    // OTHER computers only — this device's own pinned_by claim is local pin truth, not a peer
    // (ipfs.mdx §1.1). Same test computeTaskMetrics() applies to `notBackedUp`.
    for (const p of f.peers) if (p !== SELF) peers.add(p);
    if (f.analysisOnly) continue;
    bytes.total += f.sizeBytes;
    if (f.presence === "remote-only") missingHere++;
    if (f.decision === "ignore") counts.ignored++;
    else if (f.decision === "undecided") {
      if (f.pinnedForeign) counts.pinnedForeign++;
      else counts.undecided++;
    } else if (f.decision === "sync") {
      if (f.transfer === "pinned") {
        counts.pinned++;
        bytes.pinned += f.sizeBytes;
      } else counts.pending++;
      if (f.transfer === "pinned" && !f.peers.some((p) => p !== SELF)) notBackedUp++;
    }
  }
  return { counts, peerCount: peers.size, notBackedUp, missingHere, bytes };
}

beforeAll(async () => {
  await updateRepoConfig(FOLDER, (c) => ({
    ...c,
    repo: { ...c.repo, name: "fixture", path: root, remote: null },
    pinned: true,
    decisions: {
      // One of each decision the counts distinguish.
      "videos/pinned-here.mp4": "sync",
      "videos/wanted-not-here.mp4": "sync",
      // Pinned here and NOWHERE else — the single-copy case the `Not backed up` column exists for.
      "videos/only-here.mp4": "sync",
      "videos/ignored.mp4": "ignore",
      // "videos/undecided.mp4" is deliberately absent → undecided.
      // The peer's file is undecided here too, and becomes a remote-only row.
    },
  }));

  writeRepoStatus(
    FOLDER,
    UnitStatusSchema.parse({
      last_scan_at: "2026-07-01T00:00:00Z",
      last_pin_at: "2026-07-01T00:00:00Z",
      candidates: [
        candidate("videos/pinned-here.mp4", false, 100),
        candidate("videos/wanted-not-here.mp4", false, 200),
        candidate("videos/only-here.mp4", false, 400),
        candidate("videos/ignored.mp4", false, 800),
        candidate("videos/undecided.mp4", false, 1600),
        // Small analysis-only media (scan.mdx §4.1 rule 5) — present as a row, excluded from the counts.
        candidate("images/thumb.jpg", true, 3200),
      ],
    }),
  );

  writeRepoManifest(
    FOLDER,
    ManifestSchema.parse({
      generated_at: "2026-07-01T00:00:00Z",
      files: [
        // Decided + claimed by US → "pinned".
        manifestEntry("videos/pinned-here.mp4", "bafypinnedhere", [SELF, PEER], 100),
        // Decided, has a CID, but only a PEER claims it → still "pending" here.
        manifestEntry("videos/wanted-not-here.mp4", "bafywanted", [PEER], 200),
        // Decided, pinned, and claimed by NOBODY but us → pinned, and NOT backed up.
        manifestEntry("videos/only-here.mp4", "bafyonlyhere", [SELF], 400),
        // Only the peer has it and it was never scanned here → a remote-only row.
        manifestEntry("videos/only-on-the-tower.mp4", "bafyremote", [PEER], 6400),
      ],
    }),
  );
});

describe("computeRepoRow — the cheap Repos-table path", () => {
  it("counts exactly what the fully-composed One-repo rows count", async () => {
    expect((await computeRepoRow(FOLDER)).counts).toEqual((await aggregatesFromDetail()).counts);
  });

  it("reports the same distinct peer count as the composed rows", async () => {
    expect((await computeRepoRow(FOLDER)).peerCount).toEqual((await aggregatesFromDetail()).peerCount);
  });

  it("gets the counts themselves right, not merely self-consistent", async () => {
    // A row that agrees with a broken composer is worthless — pin the actual numbers too.
    expect((await computeRepoRow(FOLDER)).counts).toEqual({
      pinned: 2, // pinned-here.mp4 + only-here.mp4 — decided AND claimed by this computer
      pending: 1, // wanted-not-here.mp4 — decided, but only a peer claims it
      undecided: 2, // undecided.mp4 + the peer's only-on-the-tower.mp4 remote-only row
      ignored: 1, // ignored.mp4
      pinnedForeign: 0,
    });
  });

  it("excludes small analysis-only media from the decision counts (scan.mdx §4.1 rule 5)", async () => {
    const counts = (await computeRepoRow(FOLDER)).counts;
    const total = counts.pinned + counts.pending + counts.undecided + counts.ignored + counts.pinnedForeign;
    // Six scanned candidates + one remote-only row = seven rows, but the thumbnail owes no decision.
    expect(total).toBe(6);
  });

  // ── The Repos-table columns (repos.mdx §3.2) ───────────────────────────────────────────────────────
  //
  // Every assertion below ALSO compares against `aggregatesFromDetail()`, for the same reason the counts
  // do: the One-repo page derives these from composed FileRows, this path derives them from raw fields,
  // and a column that disagreed with the page it links to is worse than no column at all.

  it("counts PEERS as your OTHER computers — never this one (ipfs.mdx §1.1)", async () => {
    const row = await computeRepoRow(FOLDER);
    // The fixture's manifest names two devices: this computer and `the-tower`. Only one is a peer.
    // Counting our own claim was the defect: it made every locally-pinned repo read >= 1, so the LOCKED
    // "Peers = 0 means nothing is backing this repo up" alarm (repos.mdx §4.1) could not fire for the
    // one case it exists to catch — files that live on this machine and nowhere else.
    expect(row.peerCount).toBe(1);
    expect(row.peerCount).toEqual((await aggregatesFromDetail()).peerCount);
  });

  it("counts the single-copy files as NOT BACKED UP", async () => {
    const row = await computeRepoRow(FOLDER);
    // only-here.mp4 — decided, pinned, CID recorded, and claimed by nobody but us. pinned-here.mp4 has
    // the same three properties AND a peer, so it must not be counted; a remote-only row is by
    // definition held elsewhere, so it never can be.
    expect(row.notBackedUp).toBe(1);
    expect(row.notBackedUp).toEqual((await aggregatesFromDetail()).notBackedUp);
  });

  it("counts the files a peer has and this computer does not as MISSING HERE", async () => {
    const row = await computeRepoRow(FOLDER);
    expect(row.missingHere).toBe(1); // only-on-the-tower.mp4
    expect(row.missingHere).toEqual((await aggregatesFromDetail()).missingHere);
    // It is the SAME file the counts already carry (as Undecided) seen on the other axis — not an extra
    // row. If this ever exceeds the total, one of the two is double-counting.
    const c = row.counts;
    expect(row.missingHere).toBeLessThanOrEqual(
      c.pinned + c.pending + c.undecided + c.ignored + c.pinnedForeign,
    );
  });

  it("totals the BYTES of the files it counted — and only those", async () => {
    const row = await computeRepoRow(FOLDER);
    // 100 + 200 + 400 + 800 + 1600 local, + 6400 for the remote-only row. The 3200-byte thumbnail is
    // analysis-only, so it is excluded here exactly as it is from every count column.
    expect(row.bytes.total).toBe(100 + 200 + 400 + 800 + 1600 + 6400);
    // Pinned bytes are the `pinned` column's files only: pinned-here (100) + only-here (400).
    expect(row.bytes.pinned).toBe(500);
    expect(row.bytes).toEqual((await aggregatesFromDetail()).bytes);
  });

  it("counts a peer's file this computer lacks — the remote-only row reaches the table", async () => {
    // The Repos table must not under-report a repo just because the bytes live on another computer:
    // the peer's entry is exactly the file the user needs to pull down.
    expect((await computeRepoRow(FOLDER)).peerCount).toBeGreaterThan(0);
    const detail = await computeRepoDetail(FOLDER, "unreachable");
    expect(detail.files.some((f: FileRow) => f.presence === "remote-only")).toBe(true);
  });

  it("rolls up the SAME status the composed path would (repos.mdx §4.2)", async () => {
    // pending > 0 outranks undecided, so this repo reads "behind" on both paths.
    const row = await computeRepoRow(FOLDER);
    expect(row.status).toBe("behind");
    expect((await computeRepoDetail(FOLDER, "unreachable")).status).toBe(row.status);
  });

  it("reports when the census behind these numbers was taken", async () => {
    // Every count above is a projection of the last scan. Without this field an all-zero row cannot be
    // told apart from a row whose scan never ran, which is the same "a number with nothing to explain
    // it" failure the counts themselves are careful to avoid.
    expect((await computeRepoRow(FOLDER)).lastScanAt).toBe("2026-07-01T00:00:00Z");
  });
});

// The LOCKED precedence is `error > pinning > behind > needs_review > up_to_date > never` (repos.mdx §4.2),
// and `never` used to be tested BEFORE `up_to_date`: any repo without a `last_pin_at` stamp reported
// "Repo added but never pinned" no matter how much of it was pinned. That is what put a grey `never` pill
// on a row reading 114 Pinned / 0 Pending / 0 Undecided — the healthiest state the product has, labelled
// as the emptiest.
describe("rollupStatus — `never` is the LAST verdict, not the first (repos.mdx §4.2)", () => {
  const STATUS_FOLDER = "row-stats-status-fixture";
  const statusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-row-status-"));

  async function seed(opts: { lastPinAt: string | null; decided: boolean }): Promise<void> {
    await updateRepoConfig(STATUS_FOLDER, (c) => ({
      ...c,
      repo: { ...c.repo, name: "status-fixture", path: statusRoot, remote: null },
      pinned: true,
      decisions: (opts.decided ? { "videos/a.mp4": "sync" } : {}) as RepoUnitConfig["decisions"],
    }));
    writeRepoStatus(
      STATUS_FOLDER,
      UnitStatusSchema.parse({
        last_scan_at: "2026-07-01T00:00:00Z",
        last_pin_at: opts.lastPinAt,
        candidates: opts.decided ? [candidate("videos/a.mp4")] : [],
      }),
    );
    writeRepoManifest(
      STATUS_FOLDER,
      ManifestSchema.parse({
        generated_at: "2026-07-01T00:00:00Z",
        files: opts.decided ? [manifestEntry("videos/a.mp4", "bafya", [SELF, PEER])] : [],
      }),
    );
  }

  it("reads up_to_date when everything is pinned, even with no last-pin stamp", async () => {
    await seed({ lastPinAt: null, decided: true });
    const row = await computeRepoRow(STATUS_FOLDER);
    expect(row.counts.pinned).toBe(1);
    expect(row.counts.pending).toBe(0);
    expect(row.status).toBe("up_to_date");
  });

  it("still reads never when there is genuinely nothing pinned here", async () => {
    await seed({ lastPinAt: null, decided: false });
    expect((await computeRepoRow(STATUS_FOLDER)).status).toBe("never");
  });

  // `error` is the TOP of the LOCKED precedence and had no test at all — the one verdict that must win
  // over a healthy-looking count, because a repo whose last pin failed or whose folder is gone cannot be
  // "up to date" no matter what its manifest says.
  it("lets error outrank a fully-pinned repo", async () => {
    await seed({ lastPinAt: "2026-07-02T00:00:00Z", decided: true });
    const healthy = await computeRepoRow(STATUS_FOLDER);
    expect(healthy.status).toBe("up_to_date"); // …and the SAME repo with a fault:

    const withError = UnitStatusSchema.parse({
      last_scan_at: "2026-07-01T00:00:00Z",
      last_pin_at: "2026-07-02T00:00:00Z",
      last_error: "ipfs unreachable",
      candidates: [candidate("videos/a.mp4")],
    });
    writeRepoStatus(STATUS_FOLDER, withError);
    const errored = await computeRepoRow(STATUS_FOLDER);
    expect(errored.status).toBe("error");
    // The counts are untouched by the fault — only the verdict changes.
    expect(errored.counts).toEqual(healthy.counts);
  });

  it("reads error when the repo folder is gone, whatever the manifest still claims", async () => {
    await seed({ lastPinAt: "2026-07-02T00:00:00Z", decided: true });
    writeRepoStatus(
      STATUS_FOLDER,
      UnitStatusSchema.parse({
        last_scan_at: "2026-07-01T00:00:00Z",
        last_pin_at: "2026-07-02T00:00:00Z",
        repo_state: "missing",
        candidates: [candidate("videos/a.mp4")],
      }),
    );
    expect((await computeRepoRow(STATUS_FOLDER)).status).toBe("error");
  });
});

// THE DRIFT GUARD for streaming (performance.mdx P-37). `GET /api/repos/:repoId/detail/stream` does not
// compute anything of its own: it forwards the batches and snapshots `computeRepoDetail` hands it, so the
// property that has to hold is that streaming CHANGES NOTHING — the rows a reader assembles from the
// batches must be the rows the buffered route would have returned, in the same order, and the last running
// subtotal must be the final total. A streamed page that quietly disagreed with the buffered one would be
// the worst outcome of this whole change: two numbers for one repo, and no way to tell which is right.
describe("computeRepoDetail — streaming composes exactly what buffering composes", () => {
  it("the concatenated batches ARE the buffered rows, in order", async () => {
    const buffered = await computeRepoDetail(FOLDER, "unreachable");
    const batched: FileRow[] = [];
    const streamed = await computeRepoDetail(FOLDER, "unreachable", undefined, {
      onFileBatch: (b) => batched.push(...b),
      onSnapshot: () => {},
      onEnrich: () => {},
    });
    expect(batched).toEqual(buffered.files);
    expect(streamed.files).toEqual(buffered.files);
    // The streamed result is the SAME detail, minus nothing — including the aggregates beside the rows.
    expect(streamed).toEqual(buffered);
  });

  it("emits a rows-free header first, then subtotals, and the last subtotal is the total", async () => {
    const snapshots: RepoDetail[] = [];
    const final = await computeRepoDetail(FOLDER, "unreachable", undefined, {
      onFileBatch: () => {},
      onSnapshot: (d) => snapshots.push(d),
    });
    expect(snapshots.length).toBeGreaterThan(1);
    // The header: real identity, no rows yet.
    expect(snapshots[0]!.name).toBe(final.name);
    expect(snapshots[0]!.files).toEqual([]);
    // Every snapshot is marked provisional; the returned detail is not.
    expect(snapshots.every((s) => s.partial === true)).toBe(true);
    expect(final.partial).toBeUndefined();
    const last = snapshots[snapshots.length - 1]!;
    expect(last.counts).toEqual(final.counts);
    expect(last.taskMetrics).toEqual(final.taskMetrics);
    expect(last.peerCount).toEqual(final.peerCount);
    expect(last.status).toEqual(final.status);
  });

  it("defers the expensive per-row fields and reports them through onEnrich", async () => {
    // The git-ignore axis and the decision provenance cost seconds on a real repo and neither is needed to
    // DRAW a row, so they are patched in afterwards. What must hold is that they still LAND: a caller that
    // ignores `onEnrich` (every buffered caller does) still gets them, because the same values are written
    // onto the rows — this is what keeps the two paths from disagreeing.
    let patch: Record<string, unknown> | null = null;
    const d = await computeRepoDetail(FOLDER, "unreachable", undefined, {
      onFileBatch: () => {},
      onEnrich: (p) => (patch = p),
    });
    expect(patch).not.toBeNull();
    // Every candidate is a `.mp4` and the fixture's `.gitignore` is `*.mp4`, so git ignores them all —
    // and the deferral has to deliver that verdict, not merely promise it.
    const local = d.files.filter((f) => f.presence !== "remote-only" && f.path.endsWith(".mp4"));
    expect(local.length).toBeGreaterThan(0);
    expect(local.every((f) => f.gitignore === true)).toBe(true);
    // ...and a caller that ignored `onEnrich` entirely still gets exactly the same rows.
    const buffered = await computeRepoDetail(FOLDER, "unreachable");
    expect(d.files).toEqual(buffered.files);
  });

  it("an aborted signal stops the walk instead of throwing", async () => {
    // What a reader navigating away looks like from here. It must end the work, not fail the request —
    // and it must never leave a half list looking like a whole one, which is why the stream's terminal
    // `done` is what clears `partial` on the client.
    const ac = new AbortController();
    ac.abort();
    const detail = await computeRepoDetail(FOLDER, "unreachable", undefined, { signal: ac.signal });
    expect(detail.files).toEqual([]);
    // And it says so: a stopped walk is a PARTIAL census, never a complete one that happens to be empty.
    expect(detail.partial).toBe(true);
  });
});
