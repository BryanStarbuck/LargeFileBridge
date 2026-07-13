// WHERE a repo's noisy per-repo tracking files live (artifact_placement_policy.mdx §3). Historically every
// per-repo tracking artifact — above all `repo_storage.yaml`, which `refreshCounts()` re-stamps on EVERY
// scan — was written into `<repo>/.lfbridge/`, polluting the git working tree (and, in committed storage
// repos, causing real git churn) even for a repo the user never asked to transcribe. This module centralizes
// the placement decision so that noise is kept OUT of the repo until the repo crosses the "content
// threshold" — i.e. produces at least one durable user artifact (a transcript or an AI description). Until
// then the tracking state lives in a machine-local per-repo directory under the state root, which never
// touches git. This is a leaf module (state-dir + tracking.service only) so the four tracking services can
// share it without an import cycle.
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { resolveRepoStateDir } from "../../config/state-dir.js";
import { LFBRIDGE_DIR } from "./tracking.service.js";

/** Stable 12-hex key for a repo/root — sha1 of its resolved absolute path (the same scheme storage.service's
 *  `shortHash`/`storageSid` uses). Keys the machine-local per-repo state directory and the artifact latch. */
export function repoKeyFor(root: string): string {
  return crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12);
}

/** The machine-local per-repo tracking dir: `~/T/_large_files_bridge/repos/<repoKey>/` — the PRE-threshold
 *  home for `repo_storage.yaml`, sidecars, and history. Never touches git (artifact_placement_policy.mdx §3). */
export function repoStateDir(root: string): string {
  return resolveRepoStateDir(repoKeyFor(root));
}

const ARTIFACT_LATCH = ".durable-artifact";

/** True once this repo has produced at least one durable user artifact — a transcript OR an AI description
 *  (the "content threshold", artifact_placement_policy.mdx §2). A ONE-WAY latch stored in the machine-local
 *  per-repo state dir: deleting the artifact later does NOT un-cross the threshold (§11 one-way latch), so the
 *  repo's `.lfbridge/` placement never flip-flops mid-life. */
export function hasDurableArtifact(root: string): boolean {
  try {
    return fs.existsSync(path.join(repoStateDir(root), ARTIFACT_LATCH));
  } catch {
    return false;
  }
}

/** Latch the content threshold for this repo — called the first time a transcript / AI description is
 *  written for a file this repo owns (transcribe.service / describe.service). Idempotent + best-effort. */
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

/** [SEAM] The owning storage's dedicated LFB state-sync repo (storage_company.mdx §7 / storages.mdx §8), or
 *  null when none is configured. When set, a repo's noisy tracking routes to `<syncRepo>/repos/<repoKey>/` so
 *  it travels across the user's computers via that purpose-built repo. The per-storage settings surface that
 *  persists this is specced (storage_settings.mdx §4b) but not yet wired, so this returns null today. */
export function resolveStateSyncRepo(_root: string): string | null {
  return null;
}

/**
 * Resolve the directory a repo's noisy per-repo tracking files (`repo_storage.yaml`, `files/<rel>.yaml`
 * sidecars, `history/<device>.txt`) should be written to (artifact_placement_policy.mdx §3). Decision order:
 *   0. a relocated `.lfbridge/` (storage_settings.mdx §3) still wins outright, unchanged;
 *   1. the owning storage's state-sync repo → `<syncRepo>/repos/<repoKey>/` (seam; null today);
 *   2. POST-threshold + keep-`.lfbridge/` consent → the repo's own `<repo>/.lfbridge/` (as before);
 *   3. PRE-threshold (the default for an untranscribed repo) → the machine-local `repos/<repoKey>/` state
 *      dir, which never touches git — this is what stops `repo_storage.yaml` churn.
 * `relocated` / `keepsLfbridge` come from the owning storage's `.lfbridge` settings, read by the caller.
 */
export function resolveTrackingRoot(
  root: string,
  opts: { relocated?: string | null; keepsLfbridge: boolean },
): string {
  if (opts.relocated && opts.relocated.trim()) return path.resolve(opts.relocated);
  const syncRepo = resolveStateSyncRepo(root);
  if (syncRepo) return path.join(syncRepo, "repos", repoKeyFor(root));
  if (opts.keepsLfbridge && hasDurableArtifact(root)) return path.join(root, LFBRIDGE_DIR);
  return repoStateDir(root);
}
