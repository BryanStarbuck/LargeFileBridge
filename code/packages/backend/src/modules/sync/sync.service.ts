// The 15-minute sync (storage.mdx §13): move bytes for every synced:true unit over IPFS.
// read pinset -> add -> CID -> pin -> update manifest -> fetch missing -> reconcile pin cache ->
// publish committed manifest. The local IPFS pinset (`ipfs pin ls`) is the source of truth for pin
// state; the manifest `pinned_by` is a stale cache we verify and refresh against it here (§9.5).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManifestSchema, type Manifest, type ManifestFile } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import {
  listRepoFolders,
  getRepoConfig,
  updateRepoConfig,
  getRepoManifest,
  getRepoStatus,
  writeRepoManifest,
  writeRepoStatus,
  isGitWorkingTree,
} from "../store-model/units.service.js";
import { writeCommittedManifest } from "./manifest.service.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { log } from "../../shared/logging.js";

function computerLabel(): string {
  return getAppConfig().computer.label || "this-computer";
}

/**
 * Sync one repo (used by Sync-now and the scheduled worker). fileIds optional = whole repo.
 *
 * `opts.manual` marks an explicit user "Sync now" (one_repo.mdx §3.1) vs. the background scheduler.
 * The per-repo `synced` flag gates the BACKGROUND scheduler only (one_repo.mdx §3.2: "skips this repo
 * during background syncs"). A manual Sync now is the repo's primary action and must move bytes even
 * when the flag is off — otherwise the button silently no-ops while the UI still reports success.
 * Because clicking Sync now is the user explicitly opting this repo in, a manual run on an off repo
 * also flips `synced=true` so the every-15-min background sync keeps it fresh from then on.
 */
export async function syncRepoFolder(
  folder: string,
  onlyPaths?: Set<string>,
  opts: { manual?: boolean } = {},
): Promise<void> {
  const cfg = getRepoConfig(folder);
  if (!cfg.synced) {
    if (!opts.manual) {
      log.info("sync", `Skip ${folder}: synced=false.`);
      return;
    }
    await updateRepoConfig(folder, (c) => ({ ...c, synced: true }));
    cfg.synced = true;
    log.info("sync", `${folder}: manual Sync now — enabling background sync (synced=true).`);
  }
  const repoPath = expandHome(cfg.repo.path);
  if (!isGitWorkingTree(repoPath)) {
    markError(folder, "repo missing");
    return;
  }
  const health = await ipfs.health();
  if (health !== "ok") {
    markError(folder, "IPFS node unreachable");
    return;
  }
  await ipfs.enforceCompliance();

  const label = computerLabel();
  const status = getRepoStatus(folder);
  const manifest = getRepoManifest(folder);
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));

  // Learn from the filesystem which CIDs are REALLY pinned right now. The local IPFS pinset is the
  // source of truth; our manifest `pinned_by` is a stale cache we verify and refresh against it every
  // sync (storage.mdx §9.5). Read it once up front, and keep it current as we pin below.
  const pinset = new Set((await ipfs.listPins()).map((p) => p.cid));

  // Sync-decided files become manifest entries; add + pin any new / changed / no-longer-pinned ones.
  for (const [rel, decision] of Object.entries(cfg.decisions)) {
    if (decision !== "sync") continue;
    if (onlyPaths && !onlyPaths.has(rel)) continue;
    const abs = path.join(repoPath, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue; // decided-but-absent — leave for a later fetch
    }
    const existing = byPath.get(rel);
    // "Unchanged" means same bytes AND still really pinned. A size match alone is NOT enough — if the
    // pin was lost (GC, or an `ipfs pin rm` outside the app) we must re-pin so reality matches intent
    // rather than trust the stale cache (storage.mdx §9.5).
    const unchanged = existing?.cid && existing.size === st.size && pinset.has(existing.cid);
    if (unchanged) {
      setPinClaim(existing!, label, true);
      continue;
    }
    try {
      const cid = await ipfs.addFile(abs); // add streams the bytes and pins recursively (pin=true)
      pinset.add(cid);
      const entry: ManifestFile = {
        path: rel,
        cid,
        size: st.size,
        modified_at: st.mtime.toISOString(),
        sha256: null,
        pinned_by: [label],
      };
      byPath.set(rel, entry);
      log.info("sync", `Added+pinned ${rel} -> ${cid}`);
    } catch (e) {
      log.error("sync", `add failed for ${rel}: ${(e as Error).message}`);
    }
  }

  // Drop manifest entries whose decision is no longer "sync".
  for (const rel of [...byPath.keys()]) {
    if (cfg.decisions[rel] !== "sync") byPath.delete(rel);
  }

  // Fetch missing: pin any manifest CID we don't hold yet (rehydrate from peers).
  if (cfg.sync.fetch_missing) {
    for (const entry of byPath.values()) {
      if (!entry.cid) continue;
      const abs = path.join(repoPath, entry.path);
      if (fs.existsSync(abs)) continue;
      if (pinset.has(entry.cid)) continue; // already pinned locally — nothing to fetch
      try {
        await ipfs.pinAdd(entry.cid);
        pinset.add(entry.cid);
        log.info("sync", `Fetched+pinned ${entry.path} (${entry.cid})`);
      } catch (e) {
        log.warn("sync", `fetch failed for ${entry.path}: ${(e as Error).message}`);
      }
    }
  }

  // Refresh the pin cache against ground truth: this computer belongs in `pinned_by` for a CID iff the
  // local pinset actually holds it now (storage.mdx §9.5). Stale self-claims (a pin lost since the last
  // sync) are dropped here. Peer claims are left untouched — we can only verify our own.
  for (const entry of byPath.values()) {
    if (!entry.cid) continue;
    setPinClaim(entry, label, pinset.has(entry.cid));
  }

  const next: Manifest = ManifestSchema.parse({
    unit: "repo",
    generated_at: new Date().toISOString(),
    files: [...byPath.values()],
  });
  writeRepoManifest(folder, next);

  // Publish the committed in-repo manifest so git carries the list (storage.mdx §9.2).
  if (cfg.sync.publish_manifest) {
    try {
      writeCommittedManifest(repoPath, next);
    } catch (e) {
      log.warn("sync", `commit manifest failed for ${folder}: ${(e as Error).message}`);
    }
  }

  writeRepoStatus(folder, { ...status, last_sync_at: new Date().toISOString(), last_error: null });
  log.info("sync", `Synced ${folder}: ${next.files.length} file(s).`);
}

// A synchronization is always a FULL PASS over every known unit — never one repo in isolation
// (sync_process.mdx §2). A repo-scoped trigger (a manual "Sync now") only sets PRIORITY: that repo
// syncs first, then the pass continues across the rest. The pass fans out with BOUNDED CONCURRENCY so
// a 20–30-core machine syncs many repos at once instead of one-at-a-time (sync_process.mdx §4). We
// leave 2 cores free to keep the web app and IPFS node responsive; the store layer's per-file mutex
// (storage.mdx §15) makes concurrent unit syncs safe. A module-level guard collapses overlapping
// passes so rapid Sync-now clicks or an overlapping scheduleTask never stack duplicate work.
const SYNC_CONCURRENCY = Math.max(1, (os.cpus()?.length ?? 4) - 2);
let passInFlight = false;

/** Run `fn` over `items` with at most `limit` in flight at once. Each item's failure is contained. */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function syncOne(folder: string): Promise<void> {
  return syncRepoFolder(folder).catch((e) =>
    log.error("sync", `sync ${folder} failed: ${(e as Error).message}`),
  );
}

/**
 * The full sync pass over every known unit, with bounded concurrency (sync_process.mdx §2/§4).
 * `opts.priorityDone` names a unit a caller already synced first (a manual Sync now) so we do not
 * sync it twice — the pass then covers the remaining units. Overlapping passes are collapsed by the
 * in-flight guard; the priority unit itself is always synced by its caller, never gated by the guard.
 */
export async function syncAll(opts: { priorityDone?: string } = {}): Promise<void> {
  if (passInFlight) {
    log.info("sync", "Full sync pass already running — skipping duplicate.");
    return;
  }
  passInFlight = true;
  try {
    const rest = listRepoFolders().filter((f) => f !== opts.priorityDone);
    await runPool(rest, SYNC_CONCURRENCY, syncOne);
  } finally {
    passInFlight = false;
  }
}

/**
 * Set whether THIS computer claims to pin `entry.cid`, matching the real pinset (storage.mdx §9.5).
 * Only ever touches this computer's own label — peer claims are not ours to verify or edit.
 */
function setPinClaim(entry: ManifestFile, label: string, pinned: boolean): void {
  const has = entry.pinned_by.includes(label);
  if (pinned && !has) entry.pinned_by.push(label);
  else if (!pinned && has) entry.pinned_by = entry.pinned_by.filter((c) => c !== label);
}

function markError(folder: string, msg: string): void {
  const st = getRepoStatus(folder);
  writeRepoStatus(folder, { ...st, last_error: msg });
  log.warn("sync", `${folder}: ${msg}`);
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, process.env.HOME || "~");
}
