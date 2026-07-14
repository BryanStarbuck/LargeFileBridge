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

/** The marker file (in the Local-Storage per-repo state dir) whose one line is the absolute path of the
 *  owning company/Personal storage's SYNC REPO, written when the per-repo "sync tracking state to the
 *  company repo" toggle is turned on (repo_settings.mdx). Absent → no sync repo → Local-Storage-only. */
const SYNC_REPO_MARKER = ".sync-repo";

/** The per-repo subtree inside the owning storage's SYNC REPO — `<syncRepo>/repos/<repoKey>/` — or null when
 *  no sync repo is configured for this repo (the default). Leaf-safe (fs only): the marker is written by
 *  tracking-sync.service.ts `setSyncRepoMarker()` when the per-repo toggle is enabled. Used both by the
 *  Category-B additive mirror (tracking-sync.service.ts) and by the Category-A artifact `sync_repo` placement
 *  option (artifact-placement.service.ts). */
export function resolveStateSyncRepo(root: string): string | null {
  try {
    const marker = path.join(repoStateDir(root), SYNC_REPO_MARKER);
    const syncRepo = fs.readFileSync(marker, "utf8").trim();
    if (!syncRepo) return null;
    return path.join(syncRepo, "repos", repoKeyFor(root));
  } catch {
    return null; // no marker → default: Local-Storage-only
  }
}

/** The path of the sync-repo marker in this repo's Local-Storage state dir (written/removed by
 *  tracking-sync.service.ts as the per-repo toggle flips). */
export function syncRepoMarkerPath(root: string): string {
  return path.join(repoStateDir(root), SYNC_REPO_MARKER);
}
