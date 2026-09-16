// THE COST OF A PASS THAT CHANGES NOTHING (performance.mdx P-45/P-47).
//
// The sync-repo mirror is a RECONCILIATION to current state, not a queue of changes, so it runs over every
// tracked file of every mirrored repo on every backbone pass — and on a settled fleet essentially nothing
// has moved. Measured on the live machine before this pass: 7,285 ms of UNINTERRUPTED synchronous time per
// mirror+reconcile over 105 repos and 29,412 files, which `loop-watch` reported as
// `EVENT LOOP BLOCKED … up to 7310ms` and the user reported as "the pages are spinning".
//
// Three properties are what make that cheap, and each is easy to lose to an innocent-looking edit. They are
// pinned here because none of them is visible in the OUTPUT — a correct-but-slow mirror produces byte-for-
// byte the same files as a correct-and-fast one, so no other test in this suite can tell them apart:
//
//   1. A settled pass does NO WORK. Re-running the mirror over unchanged inputs must not re-read, re-parse
//      or re-write anything. (Guards the (ino, size, mtimeNs) memos.)
//   2. A CHANGE still travels. The memo caches our own completed work, not the data, so any edit on either
//      side must be picked up on the very next pass. This is the property whose loss would be silent DATA
//      LOSS between the user's computers, which is why it is tested from both directions.
//   3. The yielding driver hands the event loop back. Same walk, same result, but interruptible — a timer
//      armed before it must fire DURING it, not after.
//   4. The MIRROR hands the loop back too, past a budget (performance.mdx P-53). This was the last
//      uninterrupted stretch in the module and the one `blocking` caught holding the event loop for 79 s
//      on the reference machine. The budgeted driver keeps the small-tree case synchronous — every other
//      test in this file depends on that — so the property has to be asserted on a tree big enough to
//      exceed the budget.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import YAML from "yaml";
import {
  flushMemo,
  mirrorDrainsInFlight,
  mirrorToSyncRepo,
  mirrorToSyncRepoNow,
  reconcileFromSyncRepoYielding,
  reconcileFromSyncRepo,
  resetLedgerSyncMemo,
  setSyncRepoMarker,
} from "./tracking-sync.service.js";
import { resetSameBytesMemo } from "./tracked-file-merge.js";
import { repoStateDir } from "./tracking-root.service.js";

const REMOTE = "https://github.com/ExampleOrg/mirror-cost.git";

let repoRoot: string;
let syncRepo: string;
let stateRoot: string;
const roots: string[] = [];

/** Everything the mirror reads or writes, so a test can assert "nothing was touched". */
function stamps(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else {
        const s = fs.statSync(p, { bigint: true });
        out[r] = `${s.size}:${s.mtimeNs}`;
      }
    }
  };
  walk(dir, "");
  return out;
}

function seedRepo(): void {
  const state = repoStateDir(repoRoot);
  fs.mkdirSync(path.join(state, "files", "videos"), { recursive: true });
  fs.mkdirSync(path.join(state, "history"), { recursive: true });
  fs.writeFileSync(
    path.join(state, "manifest.yaml"),
    YAML.stringify({ schema_version: 1, unit: "repo", files: [{ path: "videos/a.mp4", cid: "bafyA", size: 10, pinned_by: ["tower"] }] }),
  );
  fs.writeFileSync(
    path.join(state, "decisions.yaml"),
    YAML.stringify({
      schema_version: 1,
      events: [
        {
          sid: "s1",
          path: "videos/a.mp4",
          asked: true,
          ipfs: true,
          gitignore: false,
          decided_by: "tower",
          decided_at: "2026-08-01T00:00:00.000Z",
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(state, "repo_storage.yaml"), YAML.stringify({ repo_storage: { name: "mirror-cost" } }));
  // Enough sidecars that a re-read would be measurable, and enough nesting to exercise the recursion.
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(
      path.join(state, "files", "videos", `a${i}.mp4.yaml`),
      YAML.stringify({ file: { path: `videos/a${i}.mp4`, name: `a${i}.mp4`, size: 10, events: [] } }),
    );
  }
  fs.writeFileSync(path.join(state, "history", "tower.txt"), "2026-08-01 seen\n");
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-mirror-cost-"));
  roots.push(base);
  repoRoot = path.join(base, "repo");
  syncRepo = path.join(base, "sync");
  stateRoot = path.join(base, "state");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(syncRepo, { recursive: true });
  process.env.LFB_STATE_DIR = stateRoot;
  resetLedgerSyncMemo();
  resetSameBytesMemo();
  seedRepo();
  setSyncRepoMarker(repoRoot, syncRepo, REMOTE);
});

afterAll(() => {
  delete process.env.LFB_STATE_DIR;
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** The mirror subtree this repo resolves to — resolved by reading it back rather than recomputing the key. */
function mirrorDir(): string {
  const repos = path.join(syncRepo, "repos");
  const names = fs.readdirSync(repos);
  expect(names).toHaveLength(1);
  return path.join(repos, names[0]!);
}

describe("a mirror pass that changes nothing costs nothing", () => {
  it("touches no file on the second pass, in either direction", () => {
    expect(mirrorToSyncRepoNow(repoRoot)).toBe(true);
    reconcileFromSyncRepo(repoRoot);

    const mirrorBefore = stamps(mirrorDir());
    const localBefore = stamps(repoStateDir(repoRoot));

    // Two more full round trips. Every one of them re-derives documents that are already correct.
    for (let i = 0; i < 2; i++) {
      mirrorToSyncRepoNow(repoRoot);
      reconcileFromSyncRepo(repoRoot);
    }

    // Not merely "the bytes are the same" — the mtimes are, which is the only way to prove nothing was
    // REWRITTEN. An unconditional write of identical bytes passes a content check and still invalidates
    // every mtime-keyed memo in the module (and re-touches a file in a git working tree on every pass).
    expect(stamps(mirrorDir())).toEqual(mirrorBefore);
    expect(stamps(repoStateDir(repoRoot))).toEqual(localBefore);
  });

  it("still carries a NEW local sidecar, and a new EVENT on an existing one, after the memo is warm", () => {
    mirrorToSyncRepoNow(repoRoot);
    reconcileFromSyncRepo(repoRoot);

    const state = repoStateDir(repoRoot);
    // A file the mirror has never seen. The equality memo only ever answers "these two are identical", so
    // a path with no destination at all can never be skipped — but that is a property worth pinning.
    fs.writeFileSync(
      path.join(state, "files", "videos", "brand-new.mp4.yaml"),
      YAML.stringify({ file: { path: "videos/brand-new.mp4", name: "brand-new.mp4", size: 7, events: [] } }),
    );
    // …and an APPEND to one the mirror already holds byte-identically, which is the case the memo is for.
    fs.writeFileSync(
      path.join(state, "files", "videos", "a7.mp4.yaml"),
      YAML.stringify({
        file: {
          path: "videos/a7.mp4",
          name: "a7.mp4",
          size: 10,
          events: [{ at: "2026-08-09T00:00:00.000Z", kind: "ipfs_pin", on_device: "tower" }],
        },
      }),
    );
    mirrorToSyncRepoNow(repoRoot);

    expect(fs.existsSync(path.join(mirrorDir(), "files", "videos", "brand-new.mp4.yaml"))).toBe(true);
    expect(fs.readFileSync(path.join(mirrorDir(), "files", "videos", "a7.mp4.yaml"), "utf8")).toContain("ipfs_pin");
  });

  it("still folds in a decision a peer pushed into the mirror after the memo is warm", () => {
    mirrorToSyncRepoNow(repoRoot);
    reconcileFromSyncRepo(repoRoot);

    // A peer's event arrives in the mirror's ledger — the case that MUST defeat the memo.
    const mirrorLedger = path.join(mirrorDir(), "decisions.yaml");
    const doc = YAML.parse(fs.readFileSync(mirrorLedger, "utf8")) as { schema_version: number; events: unknown[] };
    doc.events.push({
      sid: "s2",
      path: "videos/peer.mp4",
      asked: true,
      ipfs: true,
      gitignore: false,
      decided_by: "laptop",
      decided_at: "2026-08-02T00:00:00.000Z",
    });
    fs.writeFileSync(mirrorLedger, YAML.stringify(doc));

    reconcileFromSyncRepo(repoRoot);
    expect(fs.readFileSync(path.join(repoStateDir(repoRoot), "decisions.yaml"), "utf8")).toContain("videos/peer.mp4");
  });

  it("does not treat a VALID EMPTY mirror document as corrupt", () => {
    // A freshly created mirror subtree holds `files: []` / `events: []`. Reading that as "could not be
    // parsed" would refuse to seed the mirror forever — and report a data-loss ERROR while doing it.
    const dir = path.join(syncRepo, "repos");
    mirrorToSyncRepoNow(repoRoot);
    fs.writeFileSync(
      path.join(mirrorDir(), "manifest.yaml"),
      YAML.stringify({ schema_version: 1, unit: "repo", files: [] }),
    );
    resetLedgerSyncMemo();
    expect(mirrorToSyncRepoNow(repoRoot)).toBe(true);
    expect(fs.readFileSync(path.join(mirrorDir(), "manifest.yaml"), "utf8")).toContain("videos/a.mp4");
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("REFUSES to overwrite a mirror document that genuinely will not parse", () => {
    mirrorToSyncRepoNow(repoRoot);
    const conflicted = "<<<<<<< HEAD\nfiles: []\n=======\nfiles: []\n>>>>>>> peer\n";
    fs.writeFileSync(path.join(mirrorDir(), "manifest.yaml"), conflicted);
    resetLedgerSyncMemo();
    mirrorToSyncRepoNow(repoRoot);
    // Left exactly as it was for a human or the next git merge to settle.
    expect(fs.readFileSync(path.join(mirrorDir(), "manifest.yaml"), "utf8")).toBe(conflicted);
  });
});

describe("the memo outlives the process", () => {
  it("a RESTART re-derives nothing that has not moved", () => {
    mirrorToSyncRepoNow(repoRoot);
    reconcileFromSyncRepo(repoRoot);
    flushMemo(); // what the shutdown hook does — the debounce would otherwise lose this session's tail

    const mirrorBefore = stamps(mirrorDir());
    const localBefore = stamps(repoStateDir(repoRoot));

    // Simulate the restart: every in-memory memo is gone, the state root (and its `mirror-memo.json`) is
    // not. Without persistence this is the 7.5 s cold pass that made the first minute after every `just
    // run`, `tsx watch` reload and launchd boot the slowest minute the user ever sees.
    resetLedgerSyncMemo();

    mirrorToSyncRepoNow(repoRoot);
    reconcileFromSyncRepo(repoRoot);

    expect(stamps(mirrorDir())).toEqual(mirrorBefore);
    expect(stamps(repoStateDir(repoRoot))).toEqual(localBefore);
  });

  it("a restored memo still yields to a change made while the process was down", () => {
    mirrorToSyncRepoNow(repoRoot);
    reconcileFromSyncRepo(repoRoot);
    flushMemo();
    resetLedgerSyncMemo();

    // A peer's push landed in the mirror while this computer was not running. The persisted identity must
    // not survive that — this is the case where a wrong answer is silent data loss, not merely slowness.
    const mirrorLedger = path.join(mirrorDir(), "decisions.yaml");
    const doc = YAML.parse(fs.readFileSync(mirrorLedger, "utf8")) as { schema_version: number; events: unknown[] };
    doc.events.push({
      sid: "s9",
      path: "videos/while-you-were-out.mp4",
      asked: true,
      ipfs: true,
      gitignore: false,
      decided_by: "laptop",
      decided_at: "2026-08-03T00:00:00.000Z",
    });
    fs.writeFileSync(mirrorLedger, YAML.stringify(doc));

    reconcileFromSyncRepo(repoRoot);
    expect(fs.readFileSync(path.join(repoStateDir(repoRoot), "decisions.yaml"), "utf8")).toContain(
      "while-you-were-out.mp4",
    );
  });
});

/** Wait until no cooperative mirror drain is in flight. */
async function settleMirrorDrains(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (mirrorDrainsInFlight() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("the yielding driver is interruptible", () => {
  it("lets a timer fire DURING the walk, and returns the same result as the blocking driver", async () => {
    // The walk has to be big enough to cross a slice boundary — 40 files finish inside the first 8 ms and
    // would never yield, which would make this test pass for the wrong reason.
    const state = repoStateDir(repoRoot);
    const bulk = path.join(state, "files", "bulk");
    fs.mkdirSync(bulk, { recursive: true });
    for (let i = 0; i < 4000; i++) {
      fs.writeFileSync(
        path.join(bulk, `b${i}.mp4.yaml`),
        YAML.stringify({ file: { path: `bulk/b${i}.mp4`, name: `b${i}.mp4`, size: i, events: [] } }),
      );
    }

    // `…Now`, not the budgeted entry point: this test needs the mirror COMPLETE before it measures, or
    // the reconcile below has nothing to walk and would never reach a slice boundary — which is the one
    // thing it is here to prove.
    mirrorToSyncRepoNow(repoRoot);
    reconcileFromSyncRepo(repoRoot);
    const localAfterBlocking = stamps(repoStateDir(repoRoot));

    // Defeat the memos so the yielding pass does the FULL walk rather than a settled no-op.
    resetLedgerSyncMemo();
    resetSameBytesMemo();

    // Arm a timer, then run the yielding mirror. If the walk held the loop end to end, this callback could
    // only run AFTER the await resolved — which is exactly the bug: `setTimeout` is the same queue an HTTP
    // response is served from, so "the timer never fired during the walk" and "the page spun" are one fact.
    let firedDuring = false;
    let walkDone = false;
    const timer = setTimeout(() => {
      firedDuring = !walkDone;
    }, 0);

    await reconcileFromSyncRepoYielding(repoRoot);
    walkDone = true;
    clearTimeout(timer);

    expect(firedDuring).toBe(true);
    // Interruptible, and identical: the two drivers share one generator, so this is what stops them drifting.
    expect(stamps(repoStateDir(repoRoot))).toEqual(localAfterBlocking);
  });
});

describe("the mirror hands the loop back past its budget", () => {
  it("lets a timer fire DURING a big mirror pass, and still mirrors every file", async () => {
    // Bigger than MIRROR_SYNC_BUDGET_MS can absorb. The small-tree passes elsewhere in this file must stay
    // synchronous (they assert the return value of a completed pass), so the budget is the switch and this
    // is the only test that crosses it.
    const state = repoStateDir(repoRoot);
    const bulk = path.join(state, "files", "slow");
    fs.mkdirSync(bulk, { recursive: true });
    for (let i = 0; i < 6000; i++) {
      fs.writeFileSync(
        path.join(bulk, `s${i}.mp4.yaml`),
        YAML.stringify({ file: { path: `slow/s${i}.mp4`, name: `s${i}.mp4`, size: i, events: [] } }),
      );
    }

    // Earlier tests in this file mirror big trees too, so wait for any drain they left running — this test
    // asserts on the count and must start from zero.
    await settleMirrorDrains();

    let firedDuring = false;
    let passDone = false;
    const timer = setTimeout(() => {
      firedDuring = !passDone;
    }, 0);

    mirrorToSyncRepo(repoRoot);
    // Handed off mid-walk: the synchronous leg returned before the tree was finished, which is the whole
    // point — the caller's thread is free and the rest runs in slices.
    expect(mirrorDrainsInFlight()).toBe(1);

    // Wait for the cooperative drain. Polling on a macrotask is itself a yield, so this loop cannot make
    // the assertion below pass by accident — if the walk had held the loop we would never get here at all.
    await settleMirrorDrains();
    passDone = true;
    clearTimeout(timer);

    expect(firedDuring).toBe(true);
    expect(mirrorDrainsInFlight()).toBe(0);
    // Interrupting the walk must not lose a single file: every sidecar reached the mirror.
    const mirrored = path.join(syncRepo, "repos");
    const found = fs
      .readdirSync(mirrored)
      .flatMap((d) => {
        const dir = path.join(mirrored, d, "files", "slow");
        try {
          return fs.readdirSync(dir);
        } catch {
          return [];
        }
      });
    expect(found.length).toBe(6000);
  });
});
