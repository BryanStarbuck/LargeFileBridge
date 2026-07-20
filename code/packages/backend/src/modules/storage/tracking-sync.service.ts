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
import type { Manifest, ManifestFile } from "@lfb/shared";
import { repoStateDir, resolveStateSyncRepo, syncRepoMarkerPath, readSyncRepoMarker } from "./tracking-root.service.js";
import { repoUidFor } from "./repo-identity.js";
// The per-entry merge lives in a LEAF module so units.service can fold both manifests on the read path
// without dragging this service (and its storage.service dependency) into an import cycle.
import { mergeManifests } from "./manifest-merge.js";
export { mergeManifests } from "./manifest-merge.js";
import { resolveOwnerDedicatedRepo } from "./artifact-placement.service.js";
import { noteArtifactWritten } from "../pin/sync-trigger.service.js";
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

/** Recursively copy `src` → `dst`, skipping the machine-local files at the top level. Best-effort. */
function copyTree(src: string, dst: string, top = true): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const e of entries) {
    if (top && LOCAL_ONLY.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    try {
      if (e.isDirectory()) copyTree(s, d, false);
      else if (e.isFile()) fs.copyFileSync(s, d);
    } catch (err) {
      // Skip an unreadable/unwritable leaf; never fail the whole mirror — BUT make it observable. A file
      // that silently stops copying between the user's computers is the exact failure this module exists to
      // prevent, so a per-leaf copy failure must reach error.err (the top-level caller still returns true).
      log.warn("storage", `copyTree: failed to copy ${s} -> ${d}: ${(err as Error).message}`);
    }
  }
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
  try {
    copyTree(repoStateDir(repoRoot), dst);
    // Announce the write so the owning SDL's git backbone commits + pushes it (storage_company.mdx §8.7).
    // Without this the mirrored text sits in the SDL's working tree until the 10-minute device worker
    // happens by — a decision the user just made would take minutes to reach their other computer, and
    // "it eventually shows up" is indistinguishable from "it is broken" while you are staring at the screen.
    // The trigger resolves the SDL by root prefix, and `dst` IS inside the SDL, so it lands correctly here
    // (the case it cannot resolve is a path inside a working repo — not this one).
    noteArtifactWritten(dst, "tracking-state");
    return true;
  } catch (e) {
    log.warn("storage", `mirrorToSyncRepo(${repoRoot}) failed (path missing/unwritable): ${(e as Error).message}`);
    return false;
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
    return { schema_version: parsed.schema_version ?? 1, unit: parsed.unit ?? unit, files: parsed.files as ManifestFile[] };
  } catch {
    return empty;
  }
}

/**
 * Reconcile a pulled sync-repo subtree back into Local Storage (artifact_placement_policy.mdx §5,
 * storage_company.mdx §8.4.3). `manifest.yaml` is MERGED per entry (`mergeManifests`); everything else
 * (append-only sidecars, history, the union-folded decisions ledger) is copied, which is safe for those
 * shapes. Best-effort; no-op when no sync repo is configured for this repo.
 *
 * This used to be a wholesale `copyTree` — and had ZERO callers, so a mirrored manifest that did arrive was
 * never folded in at all. Both halves of that are fixed: the merge is real, and the pin pass calls it on
 * every backbone pull.
 */
export function reconcileFromSyncRepo(repoRoot: string): boolean {
  const src = resolveStateSyncRepo(repoRoot);
  if (!src) return false;
  const dst = repoStateDir(repoRoot);
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
      fs.mkdirSync(dst, { recursive: true });
      fs.writeFileSync(localPath, YAML.stringify(merged), "utf8");
    }
    // 2. everything else — append-only / union-folded shapes tolerate a copy
    copyTreeExcept(src, dst, new Set(["manifest.yaml"]));
    return true;
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
function copyTreeExcept(src: string, dst: string, skip: Set<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const e of entries) {
    if (skip.has(e.name) || LOCAL_ONLY.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    try {
      if (e.isDirectory()) copyTree(s, d, false);
      else if (e.isFile()) fs.copyFileSync(s, d);
    } catch (err) {
      log.warn("storage", `reconcile: failed to copy ${s} -> ${d}: ${(err as Error).message}`);
    }
  }
}
