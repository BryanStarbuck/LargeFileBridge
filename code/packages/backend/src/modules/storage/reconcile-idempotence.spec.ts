// THE RECONCILE MUST GO QUIET WHEN NOTHING ARRIVED.
//
// `reconcileFromSyncRepo` used to `return true` whenever the mirror directory merely EXISTED, regardless of
// whether a single byte had changed. Its caller, `reconcileMirroredRepos`, reads that answer as "a peer's
// state arrived", and pays for it per repo: a whole-unit-manifest merge, a decision-ledger re-parse, and a
// UI topic bump. So on a computer where nothing had happened at all, every mirrored repo did all of that on
// every backbone pass.
//
// Measured on Bryan_Tower 2026-08-10: "reconciled 106 mirrored repo(s)" every 20-30 seconds, forever, 943
// times in one log — against 106 repos whose manifests (2,091 entries for charlie-kirk alone) and six-figure
// decision ledgers had not moved. That is the allocation storm behind the memory the app was billed for:
// RSS pinned near 1 GB with heapUsed ~200 MB and nothing in flight, and on the 16 GB laptop it climbed to
// 4.5 GB and the OS killed the process — which silently stopped the 15-minute sync schedule with it.
//
// The fix is honesty: report whether the merge actually changed anything on disk.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { setSyncRepoMarker, reconcileFromSyncRepo, reconcileMirroredRepos } from "./tracking-sync.service.js";
import { repoStateDir } from "./tracking-root.service.js";
import { isDirForKey, clearKeyedDirCache } from "../../shared/store/keyed-dir.js";

const REMOTE = "https://github.com/ACT3ai/charlie-kirk.git";
let tmp: string;
let repoRoot: string;
let mirrorDir: string;

const write = (file: string, body: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
};

const manifest = (files: { path: string; cid: string }[]): string =>
  YAML.stringify({
    schema_version: 1,
    files: files.map((f) => ({ path: f.path, cid: f.cid, size: 10, pinned_by: ["tower"] })),
  });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-reconcile-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "charlie-kirk");
  fs.mkdirSync(repoRoot, { recursive: true });
  const syncRepo = path.join(tmp, "sdl");
  setSyncRepoMarker(repoRoot, syncRepo, REMOTE);
  const marker = fs.readFileSync(path.join(repoStateDir(repoRoot), ".sync-repo"), "utf8").split("\n");
  mirrorDir = path.join(syncRepo, "repos", marker[1]!.trim());
  fs.mkdirSync(mirrorDir, { recursive: true });
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("reconcileFromSyncRepo — an idempotent pass is not an arrival", () => {
  it("reports an arrival the FIRST time a peer's manifest shows up", () => {
    write(path.join(mirrorDir, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
  });

  it("goes QUIET on every pass after that, and STAYS quiet — this is the storm, gone", () => {
    write(path.join(mirrorDir, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true); // the arrival
    for (let i = 0; i < 10; i++) {
      expect(reconcileFromSyncRepo(repoRoot)).toBe(false); // ...and 10 idle passes cost nothing downstream
    }
  });

  it("speaks up again the moment something REAL arrives — the gate must not swallow the news", () => {
    write(path.join(mirrorDir, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
    expect(reconcileFromSyncRepo(repoRoot)).toBe(false);

    write(
      path.join(mirrorDir, "manifest.yaml"),
      manifest([
        { path: "videos/a.mp4", cid: "bafy1" },
        { path: "videos/b.mp4", cid: "bafy2" }, // the peer pinned a second video
      ]),
    );
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
    expect(reconcileFromSyncRepo(repoRoot)).toBe(false); // and quiet again straight after
  });

  it("counts an arriving SIDECAR as news too — a peer's transcript is a real change", () => {
    write(path.join(mirrorDir, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));
    reconcileFromSyncRepo(repoRoot);
    expect(reconcileFromSyncRepo(repoRoot)).toBe(false);

    write(
      path.join(mirrorDir, "files", "videos/a.mp4.yaml"),
      YAML.stringify({ file: { events: [{ at: "2026-08-05T09:00:00.000Z", kind: "observed", on_device: "tower" }] } }),
    );
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
    // A sidecar SETTLES on the pass after it lands: the first pass copies the peer's bytes verbatim, the
    // second rewrites them in our canonical serialization. Two passes, not forever — that is the property
    // that matters, so assert it explicitly rather than assuming one.
    reconcileFromSyncRepo(repoRoot);
    for (let i = 0; i < 5; i++) expect(reconcileFromSyncRepo(repoRoot)).toBe(false);
  });

  it("stays quiet with no mirror at all, rather than reporting an arrival from an empty directory", () => {
    expect(reconcileFromSyncRepo(repoRoot)).toBe(false);
  });
});

// THE RECEIVE PATH MUST NOT GO DEAD WHEN THE MIRROR DIRECTORY IS NAMED.
//
// artifact_placement_policy.mdx §3.1 renamed the mirror subtree from `repos/83e62afc2c80/` to
// `repos/charlie-kirk-83e62afc2c80/`. `reconcileMirroredRepos` matched incoming subtrees with an EXACT
// `present.has(uid)` — which after that rename matches nothing, so every pulled subtree would be skipped
// and the fold would silently never happen. That is the same failure shape as the §8.4.1 path-vs-remote
// key: the state travels perfectly and is never found. Membership must be tested on the KEY SUFFIX, and
// both spellings must work so a half-upgraded fleet stays coherent.
describe("the mirror subtree resolves by KEY SUFFIX, named or bare (§3.1)", () => {
  it("finds a NAMED `<slug>-<uid>` subtree the migration (or a peer) wrote", () => {
    const named = path.join(path.dirname(mirrorDir), `charlie-kirk-${path.basename(mirrorDir)}`);
    fs.renameSync(mirrorDir, named);
    clearKeyedDirCache(); // the rename is exactly what invalidates a memoized resolution

    write(path.join(named, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
    expect(reconcileFromSyncRepo(repoRoot)).toBe(false);
  });

  it("still finds a LEGACY bare-`<uid>` subtree, so a peer on an older build is not orphaned", () => {
    write(path.join(mirrorDir, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
  });

  it("matches on the suffix, never the exact name — the membership test reconcileMirroredRepos uses", () => {
    const uid = path.basename(mirrorDir);
    expect(isDirForKey(uid, uid)).toBe(true); // legacy bare
    expect(isDirForKey(`charlie-kirk-${uid}`, uid)).toBe(true); // ours
    expect(isDirForKey(`ck-mirror-${uid}`, uid)).toBe(true); // a peer that slugged it differently
    expect(isDirForKey("charlie-kirk-0123456789ab", uid)).toBe(false); // a DIFFERENT repo
  });

  // The real thing, end to end. An exact-name membership test passes the two cases above and STILL skips
  // every repo here, which is why this one is written against reconcileMirroredRepos itself.
  it("FOLDS a named subtree — reconcileMirroredRepos must not skip it", async () => {
    const uid = path.basename(mirrorDir);
    const named = path.join(path.dirname(mirrorDir), `charlie-kirk-${uid}`);
    fs.renameSync(mirrorDir, named);
    clearKeyedDirCache();
    write(path.join(named, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));

    // The repo must be a registered pin unit for reconcileMirroredRepos to consider it at all.
    write(
      path.join(process.env.LFB_STATE_DIR!, "pin", "r", "charlie-kirk", "config.yaml"),
      ["repo:", "  name: charlie-kirk", `  path: ${repoRoot}`, `  remote: ${REMOTE}`].join("\n"),
    );

    expect(await reconcileMirroredRepos(path.join(tmp, "sdl"))).toBe(1);
  });
});

// A DUPLICATE SPELLING MUST BE MERGED, NEVER CHOSEN BETWEEN (§3.1a).
//
// After the §3.1 rename, a computer still on the old build keeps writing `repos/<uid>/` while updated
// computers write `repos/<slug>-<uid>/`. Both end up in the shared repo. Because `resolveStateSyncRepo`
// resolves to ONE directory and prefers the named one, everything the older computer mirrors into the bare
// twin becomes invisible — silent, directional data loss. Measured on the real Act3 company repo on
// 2026-08-20: 67 duplicated subtrees, 19,417 files. The fold is what makes the rename safe for a fleet.
describe("duplicate mirror subtrees fold instead of shadowing each other (§3.1a)", () => {
  it("keeps the BARE twin's manifest entry — the peer's file is not lost", async () => {
    const uid = path.basename(mirrorDir);
    const parent = path.dirname(mirrorDir);
    const named = path.join(parent, `charlie-kirk-${uid}`);

    // The old build wrote the bare one; an updated computer wrote the named one. Different files in each.
    write(path.join(mirrorDir, "manifest.yaml"), manifest([{ path: "videos/from-old-build.mp4", cid: "bafyOLD" }]));
    write(path.join(named, "manifest.yaml"), manifest([{ path: "videos/from-new-build.mp4", cid: "bafyNEW" }]));
    write(
      path.join(mirrorDir, "history", "laptop.txt"),
      "2026-08-20T11:07:00Z  observed videos/from-old-build.mp4\n",
    );

    write(
      path.join(process.env.LFB_STATE_DIR!, "pin", "r", "charlie-kirk", "config.yaml"),
      ["repo:", "  name: charlie-kirk", `  path: ${repoRoot}`, `  remote: ${REMOTE}`].join("\n"),
    );
    await reconcileMirroredRepos(path.join(tmp, "sdl"));

    // The bare directory is gone, and BOTH files survive in the surviving one.
    expect(fs.existsSync(mirrorDir)).toBe(false);
    const surviving = YAML.parse(fs.readFileSync(path.join(named, "manifest.yaml"), "utf8"));
    const paths = (surviving.files as { path: string }[]).map((f) => f.path).sort();
    expect(paths).toEqual(["videos/from-new-build.mp4", "videos/from-old-build.mp4"]);
    // ...and the old build's history log came across too.
    expect(fs.existsSync(path.join(named, "history", "laptop.txt"))).toBe(true);
  });

  it("does NOTHING when there is only one spelling — the steady state costs one readdir", async () => {
    write(path.join(mirrorDir, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));
    write(
      path.join(process.env.LFB_STATE_DIR!, "pin", "r", "charlie-kirk", "config.yaml"),
      ["repo:", "  name: charlie-kirk", `  path: ${repoRoot}`, `  remote: ${REMOTE}`].join("\n"),
    );
    await reconcileMirroredRepos(path.join(tmp, "sdl"));
    expect(fs.existsSync(mirrorDir)).toBe(true); // still the only spelling, untouched
  });
});
