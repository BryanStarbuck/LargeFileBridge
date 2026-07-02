// The 15-minute sync (storage.mdx §13): move bytes for every synced:true unit over IPFS.
// add -> CID -> pin -> update manifest -> fetch missing -> publish committed manifest.
import fs from "node:fs";
import path from "node:path";
import { ManifestSchema, type Manifest, type ManifestFile } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import {
  listRepoFolders,
  getRepoConfig,
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

/** Sync one repo (used by Sync-now and the scheduled worker). fileIds optional = whole repo. */
export async function syncRepoFolder(folder: string, onlyPaths?: Set<string>): Promise<void> {
  const cfg = getRepoConfig(folder);
  if (!cfg.synced) {
    log.info("sync", `Skip ${folder}: synced=false.`);
    return;
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

  // Sync-decided files become manifest entries; add + pin any new/changed ones.
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
    const unchanged = existing?.cid && existing.size === st.size;
    if (unchanged) {
      if (!existing!.pinned_by.includes(label)) existing!.pinned_by.push(label);
      continue;
    }
    try {
      const cid = await ipfs.addFile(abs);
      const entry: ManifestFile = {
        path: rel,
        cid,
        size: st.size,
        modified_at: st.mtime.toISOString(),
        sha256: null,
        pinned_by: [label],
      };
      byPath.set(rel, entry);
      log.info("sync", `Added ${rel} -> ${cid}`);
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
      try {
        await ipfs.pinAdd(entry.cid);
        if (!entry.pinned_by.includes(label)) entry.pinned_by.push(label);
        log.info("sync", `Fetched+pinned ${entry.path} (${entry.cid})`);
      } catch (e) {
        log.warn("sync", `fetch failed for ${entry.path}: ${(e as Error).message}`);
      }
    }
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

function markError(folder: string, msg: string): void {
  const st = getRepoStatus(folder);
  writeRepoStatus(folder, { ...st, last_error: msg });
  log.warn("sync", `${folder}: ${msg}`);
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, process.env.HOME || "~");
}
