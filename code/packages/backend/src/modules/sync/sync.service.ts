// The synchronization process (sync_process.mdx). A synchronization is ALWAYS a full pass over every
// known unit — every repo PLUS the computer unit (storage.mdx §5/§8). Per unit the byte work is:
// read pinset -> add -> CID -> pin -> update manifest -> fetch missing -> reconcile pin cache ->
// publish manifest. The local IPFS pinset (`ipfs pin ls`) is the source of truth for pin state; the
// manifest `pinned_by` is a stale cache we verify and refresh against it here (storage.mdx §9.5).
//
// Parallelism (sync_process.mdx §4): the pass fans out across units, and WITHIN a unit the independent
// per-file add/pin and fetch operations fan out too — all heavy IPFS work is drawn through ONE global
// limiter (`ipfsLimiter`, size `cores − 2`) so total in-flight operations stay bounded no matter how
// units × files multiply. Concurrent state writes are safe because the store layer serializes per file
// with atomic temp-then-rename (storage.mdx §15).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManifestSchema, type Manifest, type ManifestFile, type UnitStatus, type Decision } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import {
  listRepoFolders,
  getRepoConfig,
  updateRepoConfig,
  getRepoManifest,
  getRepoStatus,
  writeRepoManifest,
  writeRepoStatus,
  getComputerConfig,
  getComputerManifest,
  getComputerStatus,
  writeComputerManifest,
  writeComputerStatus,
  isGitWorkingTree,
} from "../store-model/units.service.js";
import { writeCommittedManifest } from "./manifest.service.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { log } from "../../shared/logging.js";

function computerLabel(): string {
  return getAppConfig().computer.label || "this-computer";
}

// One global concurrency budget for ALL heavy IPFS work in a pass — bounded to `cores − 2` so a
// 20–30-core machine stays busy while 2 cores keep the web app + IPFS node responsive (sync_process.mdx
// §4). Every add/pin/fetch runs through `ipfsLimiter.run(...)`, so unit-level and file-level fan-out
// share the same ceiling and never oversubscribe the box.
const SYNC_CONCURRENCY = Math.max(1, (os.cpus()?.length ?? 4) - 2);

class Limiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
const ipfsLimiter = new Limiter(SYNC_CONCURRENCY);

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

// ── The generic unit-sync core ──────────────────────────────────────────────
// A UnitTarget adapts either a repo unit or the computer unit onto the one sync algorithm below, so the
// full pass (sync_process.mdx §2) treats them identically. Repo files resolve under the working tree;
// computer files are already absolute (the scanner labels them absolute — storage.mdx §8). `publish`
// is git for a repo (storage.mdx §9.2) and (for now) a no-op for the computer unit whose IPNS transport
// (storage.mdx §9.3) is a separate follow-up.
interface UnitTarget {
  kind: "repo" | "computer";
  name: string;
  label: string;
  decisions: Record<string, Decision>;
  fetchMissing: boolean;
  resolveAbs: (rel: string) => string;
  manifest: Manifest;
  status: UnitStatus;
  writeManifest: (m: Manifest) => void;
  writeStatus: (s: UnitStatus) => void;
  publish?: (m: Manifest) => void;
  preflightError?: () => string | null;
}

async function runUnitSync(t: UnitTarget, onlyPaths?: Set<string>): Promise<void> {
  const missing = t.preflightError?.();
  if (missing) {
    markUnitError(t, missing);
    return;
  }
  const health = await ipfs.health();
  if (health !== "ok") {
    markUnitError(t, "IPFS node unreachable");
    return;
  }
  await ipfs.enforceCompliance();

  const byPath = new Map(t.manifest.files.map((f) => [f.path, f]));

  // Learn from the filesystem which CIDs are REALLY pinned right now. The local IPFS pinset is the
  // source of truth; our manifest `pinned_by` is a stale cache we verify and refresh against it every
  // sync (storage.mdx §9.5). Read it once up front, and keep it current as we pin below.
  const pinset = new Set((await ipfs.listPins()).map((p) => p.cid));

  // Add + pin any new / changed / no-longer-pinned Sync-decided file — IN PARALLEL, bounded by the
  // global limiter (sync_process.mdx §4). Each task owns a distinct path key, so the shared `byPath` /
  // `pinset` mutations never collide (JS runs each synchronous span between awaits atomically).
  const toAdd = Object.entries(t.decisions).filter(
    ([rel, decision]) => decision === "sync" && (!onlyPaths || onlyPaths.has(rel)),
  );
  await Promise.all(
    toAdd.map(([rel]) =>
      ipfsLimiter.run(async () => {
        const abs = t.resolveAbs(rel);
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          return; // decided-but-absent — leave for a later fetch
        }
        const existing = byPath.get(rel);
        // "Unchanged" means same bytes AND still really pinned. A size match alone is NOT enough — if
        // the pin was lost (GC, or an `ipfs pin rm` outside the app) we must re-pin so reality matches
        // intent rather than trust the stale cache (storage.mdx §9.5).
        const unchanged = existing?.cid && existing.size === st.size && pinset.has(existing.cid);
        if (unchanged) {
          setPinClaim(existing!, t.label, true);
          return;
        }
        try {
          const cid = await ipfs.addFile(abs); // add streams the bytes and pins recursively (pin=true)
          pinset.add(cid);
          byPath.set(rel, {
            path: rel,
            cid,
            size: st.size,
            modified_at: st.mtime.toISOString(),
            sha256: null,
            pinned_by: [t.label],
          });
          log.info("sync", `Added+pinned ${rel} -> ${cid}`);
        } catch (e) {
          log.error("sync", `add failed for ${rel}: ${(e as Error).message}`);
        }
      }),
    ),
  );

  // Drop manifest entries whose decision is no longer "sync".
  for (const rel of [...byPath.keys()]) {
    if (t.decisions[rel] !== "sync") byPath.delete(rel);
  }

  // Fetch missing: pin any manifest CID we don't hold yet (rehydrate from peers) — also IN PARALLEL.
  if (t.fetchMissing) {
    await Promise.all(
      [...byPath.values()].map((entry) =>
        ipfsLimiter.run(async () => {
          if (!entry.cid) return;
          const abs = t.resolveAbs(entry.path);
          if (fs.existsSync(abs)) return;
          if (pinset.has(entry.cid)) return; // already pinned locally — nothing to fetch
          try {
            await ipfs.pinAdd(entry.cid);
            pinset.add(entry.cid);
            log.info("sync", `Fetched+pinned ${entry.path} (${entry.cid})`);
          } catch (e) {
            log.warn("sync", `fetch failed for ${entry.path}: ${(e as Error).message}`);
          }
        }),
      ),
    );
  }

  // Refresh the pin cache against ground truth: this computer belongs in `pinned_by` for a CID iff the
  // local pinset actually holds it now (storage.mdx §9.5). Stale self-claims (a pin lost since the last
  // sync) are dropped here. Peer claims are left untouched — we can only verify our own.
  for (const entry of byPath.values()) {
    if (!entry.cid) continue;
    setPinClaim(entry, t.label, pinset.has(entry.cid));
  }

  const next: Manifest = ManifestSchema.parse({
    unit: t.kind,
    generated_at: new Date().toISOString(),
    files: [...byPath.values()],
  });
  t.writeManifest(next);

  if (t.publish) {
    try {
      t.publish(next);
    } catch (e) {
      log.warn("sync", `publish manifest failed for ${t.name}: ${(e as Error).message}`);
    }
  }

  t.writeStatus({ ...t.status, last_sync_at: new Date().toISOString(), last_error: null });
  log.info("sync", `Synced ${t.name}: ${next.files.length} file(s).`);
}

/**
 * Sync one repo (used by Sync-now and the scheduled worker). onlyPaths optional = whole repo.
 *
 * `opts.manual` marks an explicit user "Sync now" (one_repo.mdx §3.1) vs. the background scheduler.
 * The per-repo `synced` flag gates the BACKGROUND scheduler only (one_repo.mdx §3.2: "skips this repo
 * during background syncs"). A manual Sync now is the repo's primary action and must move bytes even
 * when the flag is off — otherwise the button silently no-ops while the UI still reports success
 * (sync_process.mdx §6). Because clicking Sync now is the user explicitly opting this repo in, a manual
 * run on an off repo also flips `synced=true` so the every-15-min background sync keeps it fresh.
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
  await runUnitSync(
    {
      kind: "repo",
      name: folder,
      label: computerLabel(),
      decisions: cfg.decisions,
      fetchMissing: cfg.sync.fetch_missing,
      resolveAbs: (rel) => path.join(repoPath, rel),
      manifest: getRepoManifest(folder),
      status: getRepoStatus(folder),
      writeManifest: (m) => writeRepoManifest(folder, m),
      writeStatus: (s) => writeRepoStatus(folder, s),
      // Publish the committed in-repo manifest so git carries the list (storage.mdx §9.2).
      publish: cfg.sync.publish_manifest ? (m) => writeCommittedManifest(repoPath, m) : undefined,
      preflightError: () => (isGitWorkingTree(repoPath) ? null : "repo missing"),
    },
    onlyPaths,
  );
}

/**
 * Sync the computer unit — everything large OUTSIDE any repo (storage.mdx §8). Part of every full pass
 * (sync_process.mdx §2). Its files are stored with absolute paths, so `resolveAbs` is (home-expanded)
 * identity. It has no git to carry its manifest; the IPNS transport (storage.mdx §9.3) is a follow-up,
 * so `publish` is omitted for now — the local manifest + pins are still written and reconciled.
 */
export async function syncComputerUnit(): Promise<void> {
  const cfg = getComputerConfig();
  if (!cfg.synced) {
    log.info("sync", "Skip computer unit: synced=false.");
    return;
  }
  await runUnitSync({
    kind: "computer",
    name: "computer",
    label: computerLabel(),
    decisions: cfg.decisions,
    fetchMissing: cfg.sync.fetch_missing,
    resolveAbs: (rel) => expandHome(rel),
    manifest: getComputerManifest(),
    status: getComputerStatus(),
    writeManifest: (m) => writeComputerManifest(m),
    writeStatus: (s) => writeComputerStatus(s),
  });
}

function syncRepoSafe(folder: string): Promise<void> {
  return syncRepoFolder(folder).catch((e) =>
    log.error("sync", `sync ${folder} failed: ${(e as Error).message}`),
  );
}

/**
 * The full sync pass over every known unit — every repo PLUS the computer unit — with bounded
 * concurrency (sync_process.mdx §2/§4). `opts.priorityDone` names a unit a caller already synced first
 * (a manual Sync now) so we do not sync it twice; the pass then covers the remaining units. Overlapping
 * passes are collapsed by the in-flight guard; the priority unit itself is always synced by its caller,
 * never gated by the guard.
 */
export async function syncAll(opts: { priorityDone?: string } = {}): Promise<void> {
  if (passInFlight) {
    log.info("sync", "Full sync pass already running — skipping duplicate.");
    return;
  }
  passInFlight = true;
  try {
    const repos = listRepoFolders().filter((f) => f !== opts.priorityDone);
    await runPool(repos, SYNC_CONCURRENCY, syncRepoSafe);
    // The computer unit is part of the full pass too (storage.mdx §8).
    await syncComputerUnit().catch((e) =>
      log.error("sync", `sync computer unit failed: ${(e as Error).message}`),
    );
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

function markUnitError(t: UnitTarget, msg: string): void {
  t.writeStatus({ ...t.status, last_error: msg });
  log.warn("sync", `${t.name}: ${msg}`);
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, process.env.HOME || "~");
}
