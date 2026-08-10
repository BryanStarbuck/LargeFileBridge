// The ADDITIVE company/Personal SYNC-REPO mirror for a repo's Category-B tracking state
// (artifact_placement_policy.mdx §4-§5). Category B (`repo_storage.yaml`, `files/<rel>.yaml` sidecars,
// `history/<device>.txt`, `decisions.yaml`, `manifest.yaml`, compression records) is ALWAYS written to Local
// Storage `~/T/_large_files_bridge/repos/<repoKey>/` first (the authoritative working copy). When the owning
// company/Personal storage has a sync repo configured AND the per-repo toggle is on, that subtree is ALSO
// mirrored to `<syncRepo>/repos/<repoKey>/` so it travels between the user's computers — in addition to Local
// Storage, not instead of it. The storage's git backbone (backbone_resilience.mdx) commits + pushes the sync
// repo; this module only copies files into its working tree. Default OFF: absent the marker, every call here
// is a best-effort no-op. LOGS (launcher.log / log.log / error.err) live only in the state root and are NEVER
// under `repos/<repoKey>/`, so they are never mirrored (artifact_placement_policy.mdx §8).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { RepoStorageDocSchema, type Manifest, type ManifestFile } from "@lfb/shared";
import { repoStateDir, resolveStateSyncRepo, syncRepoMarkerPath, readSyncRepoMarker } from "./tracking-root.service.js";
import { repoUidFor } from "./repo-identity.js";
// The per-entry merge lives in a LEAF module so units.service can fold both manifests on the read path
// without dragging this service (and its storage.service dependency) into an import cycle.
import { mergeManifests, serializeManifest } from "./manifest-merge.js";
export { mergeManifests } from "./manifest-merge.js";
// The decision-ledger union merge is a LEAF for the same reason — the ledger, like the manifest, is
// SHARED state that must union, never last-writer-copy (decisions.mdx §5; the 2026-07-20 "not backed up:
// 22 here / 0 there" defect where wholesale ledger copies erased events the copy source didn't know).
import { unionLedgerEvents, parseLedgerBestEffort, serializeLedger } from "./ledger-merge.js";
import { resolveOwnerDedicatedRepo } from "./artifact-placement.service.js";
import { noteArtifactWritten } from "../pin/sync-trigger.service.js";
import { normalizeManifestPaths } from "../pin/manifest-normalize.js";
import { isStrayPathName, copyHealed } from "./sidecar-heal.js";
// The additive copy for the two shapes that had no merge: the per-file sidecars and the per-device history
// logs. Both directions route through it, so neither leg can stamp over the other side's events.
import { copyTrackedFile } from "./tracked-file-merge.js";
// The working-tree gate — a LEAF module (logging + path only), so no cycle with the git service.
import { deferWhileBusy } from "../git/worktree-gate.js";
import { bumpTopics } from "../events/state-events.service.js";
import { log } from "../../shared/logging.js";

// Machine-local files under `repos/<repoKey>/` that must NOT travel to the sync repo.
const LOCAL_ONLY = new Set([".sync-repo", ".durable-artifact"]);

/** Turn the per-repo sync-repo mirror ON (write the marker) or OFF (remove it). The marker is TWO lines —
 *  the owning storage's sync-repo absolute path, then this repo's `repoUid` (its machine-independent
 *  identity, storage_company.mdx §8.4.1) — because the mirror subtree is `<syncRepo>/repos/<repoUid>/` and
 *  a path-derived key would differ on every computer. Called from the per-repo settings PATCH when the
 *  toggle flips (repo_settings.mdx) and from `ensureSyncRepoMarker()`. Best-effort; a marker write failure
 *  just leaves the repo Local-Storage-only. */
export function setSyncRepoMarker(repoRoot: string, syncRepoRoot: string | null, remote?: string | null): void {
  const marker = syncRepoMarkerPath(repoRoot);
  try {
    if (syncRepoRoot && syncRepoRoot.trim()) {
      const uid = repoUidFor(remote ?? null);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `${path.resolve(syncRepoRoot.trim())}\n${uid ?? ""}\n`);
    } else {
      fs.rmSync(marker, { force: true });
    }
  } catch (e) {
    log.warn("storage", `setSyncRepoMarker(${repoRoot}) failed: ${(e as Error).message}`);
  }
}

/**
 * Make sure this repo's sync-repo marker reflects the CURRENT owning storage — the default-ON half of
 * storage_company.mdx §8.4.2. Called on the scan/pin path for every repo, so the mirror works out of the box
 * instead of waiting for a user to find a toggle.
 *
 * `enabled === false` is an explicit OPT-OUT and always wins (the toggle survives; it just changed polarity).
 * Otherwise we resolve the owning storage's sync repo from the repo's REMOTE ORG first, and write the marker
 * when — and only when — the repo has a remote to derive a shared identity from. No remote ⇒ no marker ⇒
 * Local-Storage-only, which is the honest answer: there is no key the user's other computers could agree on.
 *
 * Returns the resolved sync-repo ROOT (not the per-repo subtree), or null when this repo does not mirror.
 */
export function ensureSyncRepoMarker(
  repoRoot: string,
  remote: string | null,
  enabled?: boolean,
): string | null {
  if (enabled === false) {
    setSyncRepoMarker(repoRoot, null);
    return null;
  }
  if (!repoUidFor(remote)) {
    // No parseable remote → nothing shared to key on. Clear any stale marker so we never mirror into a
    // subtree keyed by a value that cannot travel.
    if (readSyncRepoMarker(repoRoot)) setSyncRepoMarker(repoRoot, null);
    return null;
  }
  let target: string | null = null;
  try {
    target = resolveOwnerDedicatedRepo(repoRoot, remote);
  } catch (e) {
    log.warn("storage", `ensureSyncRepoMarker(${repoRoot}): owner resolve failed: ${(e as Error).message}`);
    return null;
  }
  const current = readSyncRepoMarker(repoRoot);
  const uid = repoUidFor(remote);
  if (!target) {
    if (current) setSyncRepoMarker(repoRoot, null);
    return null;
  }
  if (!current || path.resolve(current.syncRepo) !== path.resolve(target) || current.repoUid !== uid) {
    setSyncRepoMarker(repoRoot, target, remote);
    log.info("storage", `repo ${repoRoot} mirrors tracking state to ${target}/repos/${uid}`);
  }
  return target;
}

/**
 * Recursively copy `src` → `dst`, skipping the machine-local files at the top level. Best-effort.
 *
 * `rel` is the path SO FAR from the per-repo state-dir root, and it is the whole reason this signature is
 * not just `(src, dst)`: it is what lets `copyTrackedFile` recognise a `files/<rel>.yaml` sidecar or a
 * `history/<device>.txt` log and MERGE it instead of stamping over it (tracked-file-merge.ts). Every other
 * shape still gets the plain copy it always got.
 */
function copyTree(src: string, dst: string, rel = ""): boolean {
  let entries: fs.Dirent[];
  let changed = false;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return false;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const e of entries) {
    if (rel === "" && LOCAL_ONLY.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
    try {
      // A `\` in the NAME is a whole relative path that lost its separators (§6.1b). Copying it verbatim
      // is what makes the bad spelling travel — and a `\` filename cannot be checked out on Windows at
      // all, so mirroring it breaks the clone for the machine that produced it. Heal it here instead.
      if (e.isFile() && isStrayPathName(e.name)) {
        changed = copyHealed(s, dst, e.name) || changed;
        continue;
      }
      if (e.isDirectory()) changed = copyTree(s, d, childRel) || changed;
      else if (e.isFile()) changed = copyTrackedFile(s, d, childRel) || changed;
    } catch (err) {
      // Skip an unreadable/unwritable leaf; never fail the whole mirror — BUT make it observable. A file
      // that silently stops copying between the user's computers is the exact failure this module exists to
      // prevent, so a per-leaf copy failure must reach error.err (the top-level caller still returns true).
      log.warn("storage", `copyTree: failed to copy ${s} -> ${d}: ${(err as Error).message}`);
    }
  }
  return changed;
}

/**
 * Mirror this repo's Local-Storage Category-B subtree into the owning storage's sync repo at
 * `<syncRepo>/repos/<repoKey>/`, so it travels. No-op (returns false) when no sync repo is configured for the
 * repo, or when the sync-repo path is missing/unwritable (artifact_placement_policy.mdx §7.1: skip the mirror,
 * WARN, keep Local Storage authoritative — never fall back to the working repo). Called best-effort after a
 * Category-B write (e.g. from `writeRepoStorage`) and on demand.
 */
export function mirrorToSyncRepo(repoRoot: string): boolean {
  const dst = resolveStateSyncRepo(repoRoot);
  if (!dst) return false;
  // NEVER write into a working copy that git is mid-cycle in (worktree-gate.ts). This copy runs on the SCAN
  // path — synchronously, from `writeRepoStorage`, with no idea a backbone cycle is in flight — and landing
  // between that cycle's fetch and its merge is precisely what made git refuse the merge ("Your local
  // changes to the following files would be overwritten by merge: repos/<uid>/repo_storage.yaml"), aborting
  // the whole storage sync. Defer instead: the cycle runs this exact mirror the moment it releases the tree.
  // Keyed by repo, so N scans during one cycle collapse into ONE mirror at the end (the mirror is a
  // reconciliation to current state, never a queue of work items).
  if (deferWhileBusy(dst, `mirror:${path.resolve(repoRoot)}`, () => void mirrorToSyncRepo(repoRoot))) {
    log.info("storage", `mirrorToSyncRepo(${repoRoot}): ${dst} is mid-git-cycle — deferred until it releases`);
    return false;
  }
  try {
    // The mirror's ledger may hold events THIS machine has not reconciled yet — a peer's push, or (two
    // clones of one remote share ONE `repos/<repoUid>/` subtree) the other clone's decisions. Capture them
    // BEFORE the tree copy overwrites the file, then write the UNION back (decisions.mdx §5). Without this
    // the copy is last-writer-wins and silently erases the other writer's events.
    const mirrorLedgerFile = path.join(dst, "decisions.yaml");
    const priorMirrorEvents = parseLedgerBestEffort(readFileOrNull(mirrorLedgerFile));
    // THE MANIFEST NEEDS THE SAME PROTECTION, AND DID NOT HAVE IT. The two files are the same kind of thing —
    // SHARED state whose entries arrive from several computers — yet only the ledger was captured here, so
    // `copyTree` below stamped this machine's whole view of the manifest over every peer's. Measured on the
    // live `all` repo: commit a6cf284e6 deleted 6 entries and 13 pin claims one commit after the peer that
    // owned them pushed them, and 8 commits in that file's history dropped entries this way. `mergeManifests`
    // has always documented "absence is NEVER a delete"; the mirror simply never called it.
    const mirrorManifestFile = path.join(dst, "manifest.yaml");
    const priorMirrorManifest = readManifestBestEffort(mirrorManifestFile, "repo");
    copyTree(repoStateDir(repoRoot), dst);
    if (priorMirrorManifest.files.length > 0) {
      try {
        const localManifest = readManifestBestEffort(path.join(repoStateDir(repoRoot), "manifest.yaml"), "repo");
        fs.writeFileSync(mirrorManifestFile, serializeManifest(mergeManifests(localManifest, priorMirrorManifest)), "utf8");
      } catch (e) {
        log.warn("storage", `mirrorToSyncRepo(${repoRoot}): manifest merge write failed: ${(e as Error).message}`);
      }
    }
    if (priorMirrorEvents.length > 0) {
      try {
        const localEvents = parseLedgerBestEffort(readFileOrNull(path.join(repoStateDir(repoRoot), "decisions.yaml")));
        fs.writeFileSync(mirrorLedgerFile, serializeLedger(unionLedgerEvents(localEvents, priorMirrorEvents)), "utf8");
      } catch (e) {
        log.warn("storage", `mirrorToSyncRepo(${repoRoot}): ledger union write failed: ${(e as Error).message}`);
      }
    }
    // Announce the write so the owning SDL's git backbone commits + pushes it (storage_company.mdx §8.7).
    // Without this the mirrored text sits in the SDL's working tree until the 10-minute device worker
    // happens by — a decision the user just made would take minutes to reach their other computer, and
    // "it eventually shows up" is indistinguishable from "it is broken" while you are staring at the screen.
    // The trigger resolves the SDL by root prefix, and `dst` IS inside the SDL, so it lands correctly here
    // (the case it cannot resolve is a path inside a working repo — not this one).
    // Scrub the MACHINE-LOCAL fields from the MIRRORED repo_storage.yaml. `last_scan.at` re-stamps on EVERY
    // scan, and every backbone pull triggers scans — so mirroring it verbatim made each storage's
    // auto-commit re-dirty the other storage's sync repo in an endless last_scan ping-pong (the 2026-08-04
    // "two sync repos fighting" defect; same churn shape as backbone_resilience.mdx's device-file fix).
    // `counts:` is the SAME KIND OF FIELD and was missed: `refreshCounts` derives it from THIS computer's
    // file index, so two computers holding different subsets of a repo's big files each overwrote the
    // other's number on every cycle — a commit per repo per cycle, forever, from a value that was never
    // shared state to begin with. With both held at their schema defaults here, the mirror's bytes change
    // only when genuinely shared state (name, policy, enlist provenance) does.
    scrubVolatileRepoStorage(path.join(dst, "repo_storage.yaml"));
    noteArtifactWritten(dst, "tracking-state");
    return true;
  } catch (e) {
    log.warn("storage", `mirrorToSyncRepo(${repoRoot}) failed (path missing/unwritable): ${(e as Error).message}`);
    return false;
  }
}

/**
 * The `repo_storage.yaml` fields that describe THIS COMPUTER rather than the repo. They are reset to their
 * schema defaults in the mirror copy (so they never travel) and preserved from the local copy on reconcile
 * (so an arriving copy never blanks them here). Anything shared — `name`, `policy`, `enlisted` — is absent
 * from this list and travels normally.
 */
const MACHINE_LOCAL_REPO_STORAGE = ["last_scan", "counts"] as const;

/** Rewrite a MIRROR copy of repo_storage.yaml with every {@link MACHINE_LOCAL_REPO_STORAGE} field reset to
 *  its schema default, serialized exactly like writeRepoStorage (deterministic key order) so an
 *  otherwise-unchanged doc is byte-stable across mirrors. Best-effort: an unparseable file is left as copied. */
function scrubVolatileRepoStorage(file: string): void {
  try {
    const parsed = RepoStorageDocSchema.safeParse(YAML.parse(fs.readFileSync(file, "utf8")) ?? {});
    if (!parsed.success) return;
    const defaults = RepoStorageDocSchema.parse({ repo_storage: {} }).repo_storage;
    for (const key of MACHINE_LOCAL_REPO_STORAGE) {
      (parsed.data.repo_storage as Record<string, unknown>)[key] = (defaults as Record<string, unknown>)[key];
    }
    fs.writeFileSync(file, YAML.stringify(parsed.data, { sortMapEntries: true }), "utf8");
  } catch {
    /* missing/unreadable mirror copy — nothing to scrub */
  }
}

/** Read a file's text, or null when missing/unreadable — the best-effort read both ledger merges use. */
function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Read a manifest YAML best-effort; a missing/corrupt/half-merged file yields an empty manifest rather than
 *  throwing, so one bad copy never blocks the whole reconcile. */
function readManifestBestEffort(file: string, unit: Manifest["unit"]): Manifest {
  const empty: Manifest = { schema_version: 1, unit, files: [] };
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (raw.includes("<<<<<<<")) return empty; // conflict markers — treat as nothing to merge
    const parsed = YAML.parse(raw) as Partial<Manifest> | null;
    if (!parsed || !Array.isArray(parsed.files)) return empty;
    // Same POSIX-separator heal as the primary reader (manifest.service.ts): a Windows peer's mirrored
    // copy carries `\` paths, and merging those unnormalized would re-introduce duplicate spellings of
    // the same file into Local Storage on every reconcile.
    return normalizeManifestPaths(
      { schema_version: parsed.schema_version ?? 1, unit: parsed.unit ?? unit, files: parsed.files as ManifestFile[] },
      file,
    );
  } catch {
    return empty;
  }
}

/**
 * Reconcile a pulled sync-repo subtree back into Local Storage (artifact_placement_policy.mdx §5,
 * storage_company.mdx §8.4.3). `manifest.yaml` is MERGED per entry (`mergeManifests`), `decisions.yaml` by
 * event union, `repo_storage.yaml` field-wise; the per-file sidecars and per-device history logs are
 * MERGED by `copyTrackedFile` (tracked-file-merge.ts). Only shapes with no shared state left — anything
 * neither side appends to concurrently — are still a plain copy. Best-effort; no-op when no sync repo is
 * configured for this repo.
 *
 * "Append-only" was long treated as licence to copy. It is not: two computers appending to one list
 * produce two supersets of a common prefix, and a copy in either direction keeps one and deletes the
 * other's tail — which is how sidecar events written between mirrors were being lost.
 *
 * This used to be a wholesale `copyTree` — and had ZERO callers, so a mirrored manifest that did arrive was
 * never folded in at all. Both halves of that are fixed: the merge is real, and the pin pass calls it on
 * every backbone pull.
 */
/**
 * Write `content` to `file` only when that would actually change it, and say whether it did.
 *
 * The three merged documents below are RECONCILIATIONS: on a computer where nothing arrived, the merge
 * result is byte-identical to what is already on disk. Writing it anyway is not merely wasted I/O — the
 * return value of `reconcileFromSyncRepo` is what tells `reconcileMirroredRepos` to run the EXPENSIVE fold
 * (a full unit-manifest merge, a ledger re-parse, and a UI topic bump) for that repo, so "I wrote a file"
 * masquerading as "something arrived" made all of that run for every repo on every pass. See the caller.
 */
function writeIfDifferent(file: string, content: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === content) return false;
  } catch {
    /* absent or unreadable — fall through and write it */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return true;
}

export function reconcileFromSyncRepo(repoRoot: string): boolean {
  const src = resolveStateSyncRepo(repoRoot);
  if (!src) return false;
  const dst = repoStateDir(repoRoot);
  // Did anything ACTUALLY arrive? Reported honestly — see `writeIfDifferent` and the caller.
  let changed = false;
  try {
    if (!fs.existsSync(src)) return false;
    // 1. the manifest — a MERGE, never a copy (§8.4.3)
    const incomingManifest = path.join(src, "manifest.yaml");
    if (fs.existsSync(incomingManifest)) {
      const localPath = path.join(dst, "manifest.yaml");
      const merged = mergeManifests(
        readManifestBestEffort(localPath, "repo"),
        readManifestBestEffort(incomingManifest, "repo"),
      );
      // The CANONICAL serializer, not a bare stringify: this file is also written by manifest.service, and
      // two spellings of one document make each writer re-dirty what the other just wrote (§6).
      changed = writeIfDifferent(localPath, serializeManifest(merged)) || changed;
    }
    // 2. the decision ledger — ALSO a merge, never a copy (decisions.mdx §5). A copy replaces the local
    // log with whatever the mirror last held; events recorded here but not yet mirrored (or erased from
    // the mirror by another writer's copy) would vanish, leaving frozen-cache decisions with no ledger
    // event that could ever travel — the "not backed up: 22 here / 0 there" defect. Union keeps both
    // sides; foldLedger resolves any conflict deterministically on read.
    const incomingLedger = path.join(src, "decisions.yaml");
    if (fs.existsSync(incomingLedger)) {
      const localLedger = path.join(dst, "decisions.yaml");
      const merged = unionLedgerEvents(
        parseLedgerBestEffort(readFileOrNull(localLedger)),
        parseLedgerBestEffort(readFileOrNull(incomingLedger)),
      );
      changed = writeIfDifferent(localLedger, serializeLedger(merged)) || changed;
    }
    // 2b. repo_storage.yaml — a MERGE that PRESERVES this computer's own {@link MACHINE_LOCAL_REPO_STORAGE}
    // fields. The mirror's copy is scrubbed of them on purpose (see mirrorToSyncRepo); a wholesale copy
    // would blank this machine's `last_scan` stamp on every pull, making the stale-scan trigger re-scan
    // constantly — which re-stamps and re-mirrors, i.e. the exact churn loop the scrub exists to break —
    // and would replace this machine's `counts` with a peer's view of a different set of files on disk.
    const incomingStorage = path.join(src, "repo_storage.yaml");
    if (fs.existsSync(incomingStorage)) {
      try {
        const incoming = RepoStorageDocSchema.safeParse(YAML.parse(fs.readFileSync(incomingStorage, "utf8")) ?? {});
        if (incoming.success) {
          const localFile = path.join(dst, "repo_storage.yaml");
          const local = RepoStorageDocSchema.safeParse(YAML.parse(readFileOrNull(localFile) ?? "") ?? {});
          if (local.success) {
            for (const key of MACHINE_LOCAL_REPO_STORAGE) {
              (incoming.data.repo_storage as Record<string, unknown>)[key] = (
                local.data.repo_storage as Record<string, unknown>
              )[key];
            }
          }
          changed = writeIfDifferent(localFile, YAML.stringify(incoming.data, { sortMapEntries: true })) || changed;
        }
      } catch (e) {
        log.warn("storage", `reconcile: repo_storage fold failed for ${dst}: ${(e as Error).message}`);
      }
    }
    // 3. everything else — the per-file sidecars and per-device history logs are MERGED inside
    //    `copyTrackedFile`; only shapes with nothing shared to lose are still copied outright.
    changed = copyTreeExcept(src, dst, new Set(["manifest.yaml", "decisions.yaml", "repo_storage.yaml"])) || changed;
    return changed;
  } catch (e) {
    log.warn("storage", `reconcileFromSyncRepo(${repoRoot}) failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Fold every mirrored repo subtree that just arrived in `sdlRoot` back into this computer's Local Storage —
 * the RECEIVE half of storage_company.mdx §8.4.3, called right after the SDL's git fetch + merge.
 *
 * Reconcile must run on EVERY backbone pull, not on demand: a merge that only happens when someone clicks
 * something is a merge that does not happen. Each local repo is matched to an incoming subtree by `repoUid`
 * (the normalized remote), which is exactly why the key had to stop being a path hash — the Tower wrote
 * `repos/<uid>/` and the laptop must find that same directory.
 *
 * Best-effort and non-throwing: this runs inside the git cycle, and a bad repo unit must never fail the pull.
 * Returns how many repos were folded in.
 */
export async function reconcileMirroredRepos(sdlRoot: string): Promise<number> {
  const mirrorDir = path.join(path.resolve(sdlRoot), "repos");
  if (!fs.existsSync(mirrorDir)) return 0;
  let folded = 0;
  try {
    // LAZY import — units.service → repo-storage.service → (here) is a cycle if imported statically.
    const { listRepoFolders, getRepoConfig, getRepoManifest, writeRepoManifest, repoBumpTopics } = await import(
      "../store-model/units.service.js"
    );
    const { readRepoTrackingManifest } = await import("../pin/manifest.service.js");
    const present = new Set(fs.readdirSync(mirrorDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
    if (present.size === 0) return 0;
    for (const folder of listRepoFolders()) {
      try {
        const cfg = getRepoConfig(folder);
        const repoPath = cfg.repo.path;
        const uid = repoUidFor(cfg.repo.remote ?? null);
        if (!repoPath || !uid || !present.has(uid)) continue;
        // Make sure this repo points at THIS sync repo before folding, so a repo whose marker was never
        // written (the default-ON case on a fresh computer) still receives its peer's state.
        ensureSyncRepoMarker(repoPath, cfg.repo.remote ?? null, cfg.sync_repo?.enabled);
        if (!reconcileFromSyncRepo(repoPath)) continue;
        folded++;
        // A fold is THE moment a peer's file becomes visible here (storage_company.mdx §8.9). Bump the
        // repo's topic explicitly rather than relying on the `writeRepoManifest` below to do it: that call
        // is wrapped in its own try/catch, and a page that stays stale because the notification rode on the
        // one step that failed is the exact silent-staleness this bus exists to eliminate.
        bumpTopics(repoBumpTopics(folder));
        // §8.6 — the merge must land in BOTH manifests. The reconcile above writes Local Storage (what the
        // Pull-down list and the mirror read); the One-Repo FILE ROWS read the unit manifest. Updating only
        // one leaves the user with a Pull-down count that no row explains, or a row that cannot be pulled.
        try {
          writeRepoManifest(folder, mergeManifests(getRepoManifest(folder), readRepoTrackingManifest(repoPath)));
        } catch (e) {
          log.warn("storage", `reconcile: unit manifest fold for ${folder} failed: ${(e as Error).message}`);
        }
        // Project the just-merged ledger onto the frozen `decisions:` cache NOW (decisions.mdx §7) — the
        // pin engine reads that cache, so without this a teammate's arriving "Add to IPFS" sat invisible
        // until the next scan happened to call reconcile. LAZY import: decisions.service statically
        // imports this module (mirrorToSyncRepo), so a static import here is a cycle.
        try {
          const { reconcile: reconcileDecisions } = await import("./decisions.service.js");
          const { changed } = await reconcileDecisions(folder);
          if (changed.length > 0) {
            log.info("storage", `reconcile: ${changed.length} decision(s) updated from the mirrored ledger for ${folder}`);
          }
        } catch (e) {
          log.warn("storage", `reconcile: decision projection for ${folder} failed: ${(e as Error).message}`);
        }
      } catch (e) {
        log.warn("storage", `reconcileMirroredRepos: repo unit ${folder} skipped: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    log.warn("storage", `reconcileMirroredRepos(${sdlRoot}) failed: ${(e as Error).message}`);
  }
  if (folded > 0) log.info("storage", `reconciled ${folded} mirrored repo(s) from ${sdlRoot}`);
  return folded;
}

/** copyTree, skipping named top-level entries (the manifest, which is merged instead of copied). */
function copyTreeExcept(src: string, dst: string, skip: Set<string>): boolean {
  let entries: fs.Dirent[];
  let changed = false;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return false;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const e of entries) {
    if (skip.has(e.name) || LOCAL_ONLY.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    try {
      // THE INGRESS HEAL (§6.1b). This is the direction that put the strays back on this disk 2 minutes
      // after they were deleted: a peer on an older build re-added `files/jfk\training\clip.mp4.yaml` to
      // the shared sync repo, and this copy materialized it locally again. Normalize on arrival, and the
      // bounce becomes one-way — the peer can keep sending it, it stops here.
      if (e.isFile() && isStrayPathName(e.name)) {
        changed = copyHealed(s, dst, e.name) || changed;
        continue;
      }
      // `e.name` IS the state-dir-relative path at this level, so the sidecar/history merge sees the
      // `files/` and `history/` prefixes it keys on.
      if (e.isDirectory()) changed = copyTree(s, d, e.name) || changed;
      else if (e.isFile()) changed = copyTrackedFile(s, d, e.name) || changed;
    } catch (err) {
      log.warn("storage", `reconcile: failed to copy ${s} -> ${d}: ${(err as Error).message}`);
    }
  }
  return changed;
}
