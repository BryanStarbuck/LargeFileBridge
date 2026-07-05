// The 15-minute sync (storage.mdx §13): move bytes for every synced:true unit over IPFS.
// read pinset -> add -> CID -> pin -> update manifest -> fetch missing -> reconcile pin cache ->
// publish committed manifest. The local IPFS pinset (`ipfs pin ls`) is the source of truth for pin
// state; the manifest `pinned_by` is a stale cache we verify and refresh against it here (§9.5).
import fs from "node:fs";
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

export async function syncAll(): Promise<void> {
  for (const folder of listRepoFolders()) {
    try {
      await syncRepoFolder(folder);
    } catch (e) {
      log.error("sync", `sync ${folder} failed: ${(e as Error).message}`);
    }
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
