// WHERE a repo's noisy per-repo tracking files live (artifact_placement_policy.mdx). The split is by DATA
// CATEGORY, not a content threshold:
//   • Category A — the user's derived CONTENT (transcripts / AI descriptions) — lives in the WORKING repo's
//     committed `.lfbridge/` and travels with the repo (placed by artifact-placement.service.ts).
//   • Category B — LFB's noisy COMPRESSION / BIG-FILE / GIT-IGNORE tracking state (`repo_storage.yaml`,
//     `files/<rel>.yaml` sidecars, `history/<device>.txt`, `decisions.yaml`, `manifest.yaml`, compression
//     records) — NEVER enters a working repo. It lives in LOCAL STORAGE at
//     `~/T/_large_files_bridge/repos/<repoKey>/` ALWAYS (this module), which never touches git, so it can
//     never merge-conflict — the failure this redesign fixes. When the owning company/Personal storage has a
//     SYNC REPO configured and the per-repo toggle is on, that state is ADDITIONALLY mirrored to
//     `<syncRepo>/repos/<repoKey>/` by tracking-sync.service.ts (additive, not instead of Local Storage).
// This is a leaf module (state-dir only) so the tracking services share it without an import cycle.
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { resolveRepoStateDir } from "../../config/state-dir.js";

// A repo's MACHINE-INDEPENDENT identity (storage_company.mdx §8.4.1) — re-exported here because this module
// is the one place callers look for "how a repo is keyed". `repoKeyFor` (below) keys Local Storage by path;
// `repoUidFor` keys the SHARED sync-repo mirror by the normalized git remote. Two keys, two jobs.
export { repoUidFor, normalizeRemoteKey } from "./repo-identity.js";

/** Stable 12-hex key for a repo/root — sha1 of its resolved absolute path (the same scheme storage.service's
 *  `shortHash`/`storageSid` uses). Keys the Local-Storage per-repo state directory and the sync-repo subtree. */
export function repoKeyFor(root: string): string {
  return crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12);
}

/** The Local-Storage per-repo tracking dir: `~/T/_large_files_bridge/repos/<repoKey>/` — the ALWAYS home for
 *  `repo_storage.yaml`, sidecars, history, `decisions.yaml`, and `manifest.yaml`. Never touches git
 *  (artifact_placement_policy.mdx §2/§3). */
export function repoStateDir(root: string): string {
  return resolveRepoStateDir(repoKeyFor(root));
}

const ARTIFACT_LATCH = ".durable-artifact";

/** True once this repo has produced at least one durable user artifact — a transcript OR an AI description.
 *  Retained as a "does this repo have content?" marker; it NO LONGER affects tracking-state placement
 *  (Category B is always Local Storage). A one-way latch in the Local-Storage per-repo state dir. */
export function hasDurableArtifact(root: string): boolean {
  try {
    return fs.existsSync(path.join(repoStateDir(root), ARTIFACT_LATCH));
  } catch {
    return false;
  }
}

/** Latch that this repo has produced content — called the first time a transcript / AI description is written
 *  (transcribe.service / describe.service). Idempotent + best-effort. Kept for content-presence checks;
 *  does not move any tracking state. */
export function markDurableArtifact(root: string): void {
  try {
    const dir = repoStateDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const latch = path.join(dir, ARTIFACT_LATCH);
    if (!fs.existsSync(latch)) fs.writeFileSync(latch, new Date().toISOString());
  } catch {
    /* best-effort: a failed latch just means the next artifact write tries again */
  }
}

/**
 * Resolve the directory a repo's Category-B tracking files (`repo_storage.yaml`, `files/<rel>.yaml` sidecars,
 * `history/<device>.txt`, `decisions.yaml`, `manifest.yaml`) are written to. It is ALWAYS the Local-Storage
 * `repos/<repoKey>/` dir (artifact_placement_policy.mdx §2) — there is no tier that writes tracking state into
 * a working repo. The optional company/Personal sync repo is an ADDITIVE mirror handled separately
 * (tracking-sync.service.ts `mirrorToSyncRepo`), so this resolver stays a simple, leaf, always-Local-Storage
 * function. The `opts` are accepted for backward compatibility with the tracking services and ignored — the
 * keep-`.lfbridge/` consent and any relocated `.lfbridge/` govern only the Category-A content artifacts.
 */
export function resolveTrackingRoot(
  root: string,
  _opts?: { relocated?: string | null; keepsLfbridge?: boolean },
): string {
  return repoStateDir(root);
}

/** The marker file (in the Local-Storage per-repo state dir) recording where this repo's tracking state
 *  mirrors to. TWO lines (storage_company.mdx §8.4.1):
 *    line 1 — the absolute path of the owning company/Personal storage's SYNC REPO
 *    line 2 — this repo's `repoUid`, its MACHINE-INDEPENDENT identity (hash of the normalized git remote)
 *  Absent → no sync repo → Local-Storage-only. A legacy one-line marker is still honored (it just cannot
 *  name a shared subtree, so it resolves to null and the next `ensureSyncRepoMarker()` pass rewrites it). */
const SYNC_REPO_MARKER = ".sync-repo";

/** Read the two-line sync-repo marker → `{ syncRepo, repoUid }`, or null when absent/blank. */
export function readSyncRepoMarker(root: string): { syncRepo: string; repoUid: string | null } | null {
  try {
    const raw = fs.readFileSync(path.join(repoStateDir(root), SYNC_REPO_MARKER), "utf8");
    const [syncRepo, repoUid] = raw.split("\n").map((l) => l.trim());
    if (!syncRepo) return null;
    return { syncRepo, repoUid: repoUid || null };
  } catch {
    return null; // no marker → default: Local-Storage-only
  }
}

/** The per-repo subtree inside the owning storage's SYNC REPO — **`<syncRepo>/repos/<repoUid>/`** — or null
 *  when no sync repo is configured for this repo, or when the repo has no remote to derive a shared identity
 *  from (storage_company.mdx §8.4.1). Leaf-safe (fs only): the marker is written by tracking-sync.service.ts
 *  `setSyncRepoMarker()` / `ensureSyncRepoMarker()`. Used both by the Category-B additive mirror
 *  (tracking-sync.service.ts) and by the Category-A artifact `sync_repo` placement option
 *  (artifact-placement.service.ts).
 *
 *  Keyed by `repoUid`, NEVER by `repoKey`: repoKey is sha1(absolute path), so the user's two computers would
 *  write to different directories inside the same sync repo and never see each other's state — the defect
 *  §8.4.1 closes. */
export function resolveStateSyncRepo(root: string): string | null {
  const marker = readSyncRepoMarker(root);
  if (!marker || !marker.repoUid) return null;
  return path.join(marker.syncRepo, "repos", marker.repoUid);
}

/** The path of the sync-repo marker in this repo's Local-Storage state dir (written/removed by
 *  tracking-sync.service.ts as the per-repo toggle flips). */
export function syncRepoMarkerPath(root: string): string {
  return path.join(repoStateDir(root), SYNC_REPO_MARKER);
}
