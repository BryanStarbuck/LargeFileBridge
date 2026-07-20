// WORKING-REPO artifact delivery + convergence (artifact_placement_policy.mdx §1.1.2, backbone_resilience.mdx §6.4).
//
// The gap this module closes, proven live on charlie-kirk (2026-07-20): a COMPANY working repo held 158
// finished `.ai_description` + 59 `.transcription` files under its committed `.lfbridge/`, and the user's
// second computer reported described=0 / transcribed≈0 — it recognized NONE of the finished work. Two
// independent faults compounded:
//
//   1. STRANDED AT THE SOURCE — legacy nudge lines (`.lfbridge/`, `*.transcription`, `*.ai_description`)
//      written into the repo's `.gitignore` by since-deleted code made every artifact invisible to git
//      (healed here via gitignore.service `repairLegacyArtifactIgnores`), AND sync-trigger's
//      `noteArtifactWritten` was a hard no-op for working repos — no code path had "commit the finished
//      work" as its purpose there. That is the stowaway defect (storage_personal.mdx §18.5.1) alive and
//      well for the working-repo case the SDL fix never covered.
//   2. NO PATH HOME — nothing on the OTHER computer ever pulled a tracked working repo, so even a pushed
//      artifact had no way to arrive; the unit just sat "behind" forever.
//
// The GUEST rule survives, narrowed to what it actually protects: LFB never commits the USER'S content in
// a working repo. The `.lfbridge/` quarantine directory is LFB's OWN output (that is the entire point of
// quarantining it — artifact_placement_policy.mdx §0), so committing THAT PATHSPEC ONLY, plus the
// `.gitignore` heal that makes it possible, touches nothing of the user's. Likewise convergence is
// fetch + `--ff-only` merge: it can never create a conflict, never rewrites, never force-anythings —
// if fast-forward is impossible it logs, surfaces via the debug export, and leaves the repo alone.
import fs from "node:fs";
import path from "node:path";
import { log } from "../../shared/logging.js";
import { openRepo } from "../git/git.service.js";
import { repairLegacyArtifactIgnores } from "../git/gitignore.service.js";
import { resolveStorageType, usesLfbridgeDir, LFBRIDGE_DIR } from "../storage/storage-type.service.js";
import { hasDurableArtifact } from "../storage/tracking-root.service.js";
import { expandHome } from "../fs/badges.js";

export interface RepoArtifactSyncResult {
  ran: boolean;
  healed: string[];
  committed: boolean;
  pushed: boolean;
  problem: string | null;
}

/** A WORKING repo (never an SDL — those have their own backbone cycle) with a real `.git/`. */
function isWorkingGitRepo(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, ".git")) && usesLfbridgeDir(resolveStorageType(root));
  } catch {
    return false;
  }
}

/** Count staged paths by artifact kind for an honest commit message (storage_personal.mdx §17.4.2). */
function describeStaged(paths: string[]): string {
  const n = (ext: string): number => paths.filter((p) => p.endsWith(ext)).length;
  const parts: string[] = [];
  const desc = n(".ai_description");
  const tx = n(".transcription");
  const ocr = n(".ocr");
  if (desc) parts.push(`${desc} AI description${desc === 1 ? "" : "s"}`);
  if (tx) parts.push(`${tx} transcript${tx === 1 ? "" : "s"}`);
  if (ocr) parts.push(`${ocr} OCR text${ocr === 1 ? "" : "s"}`);
  const other = paths.length - desc - tx - ocr;
  if (other > 0) parts.push(`${other} other artifact file${other === 1 ? "" : "s"}`);
  return parts.join(", ") || "artifact tree";
}

/**
 * Commit and push a working repo's `.lfbridge/` artifact quarantine — and NOTHING else.
 *
 * Steps: heal the legacy artifact-ignore lines → `git add -- .lfbridge` (+ `.gitignore` only when the
 * heal edited it this pass) → commit WITH AN EXPLICIT PATHSPEC (so any unrelated changes the user has
 * staged are untouched) → push, with ONE fetch + `--ff-only` + re-push retry on a non-fast-forward
 * reject. Never a force-push, never `add -A`, never a merge that could conflict.
 */
export async function syncWorkingRepoArtifacts(repoRoot: string): Promise<RepoArtifactSyncResult> {
  const result: RepoArtifactSyncResult = { ran: false, healed: [], committed: false, pushed: false, problem: null };
  const root = path.resolve(expandHome(repoRoot));
  if (!isWorkingGitRepo(root)) return result;
  if (!fs.existsSync(path.join(root, LFBRIDGE_DIR))) return result; // no quarantine → nothing of ours to ship
  result.ran = true;

  result.healed = repairLegacyArtifactIgnores(root);
  const pathspecs = [LFBRIDGE_DIR, ...(result.healed.length > 0 ? [".gitignore"] : [])];

  const git = openRepo(root);
  try {
    await git.add(["--", ...pathspecs]);
    const status = await git.status();
    const ours = [
      ...status.created,
      ...status.staged,
      ...status.deleted,
      ...status.renamed.map((r) => r.to),
    ].filter((p) => p === ".gitignore" || p.startsWith(`${LFBRIDGE_DIR}/`));
    if (ours.length === 0) return result; // nothing of ours changed — a guest leaves quietly
    const healedNote = result.healed.length > 0 ? " (healed legacy .gitignore artifact-ignore lines)" : "";
    // Commit with the explicit pathspec: only the quarantine (+ the heal) enters this commit, whatever
    // else the user may have staged.
    await git.commit(`LFB: ${describeStaged(ours)}${healedNote}`, pathspecs);
    result.committed = true;
    log.info("sync", `${root}: committed ${ours.length} .lfbridge artifact file(s)${healedNote}`);
  } catch (e) {
    result.problem = `artifact commit failed: ${(e as Error).message}`;
    log.warn("sync", `${root}: ${result.problem}`);
    return result;
  }

  try {
    const remotes = await git.getRemotes();
    if (!remotes.some((r) => r.name === "origin")) {
      result.problem =
        "committed locally but this repo has no git remote — the finished work cannot reach your other computers.";
      log.warn("sync", `${root}: ${result.problem}`);
      return result;
    }
    const branch = (await git.status()).current ?? "main";
    try {
      await git.push("origin", branch);
      result.pushed = true;
    } catch {
      // Non-fast-forward (someone pushed since) — converge fast-forward-only and retry ONCE.
      await git.fetch("origin", branch);
      await git.raw(["merge", "--ff-only", `origin/${branch}`]).catch(() => {});
      await git.push("origin", branch);
      result.pushed = true;
    }
    log.info("sync", `${root}: pushed .lfbridge artifacts to origin/${branch}`);
  } catch (e) {
    result.problem = `artifact push failed: ${(e as Error).message}`;
    log.warn("sync", `${root}: ${result.problem}`);
  }
  return result;
}

/**
 * Pull a tracked working repo's finished work DOWN from origin — the receive side of artifact delivery.
 * fetch + `merge --ff-only`: strictly additive history, can never conflict, never merges when the local
 * branch has diverged (that is the user's call, not a guest's). Gated to repos where LFB artifacts are
 * in play (`.lfbridge/` on disk or the durable-artifact latch) so LFB never touches an ordinary repo.
 */
export async function convergeWorkingRepoFromOrigin(
  repoRoot: string,
  reason: string,
): Promise<{ converged: boolean; problem: string | null }> {
  const root = path.resolve(expandHome(repoRoot));
  if (!isWorkingGitRepo(root)) return { converged: false, problem: null };
  if (!fs.existsSync(path.join(root, LFBRIDGE_DIR)) && !hasDurableArtifact(root)) {
    return { converged: false, problem: null };
  }
  // Heal locally too: a poisoned .gitignore on the RECEIVING machine would re-strand its own future writes.
  repairLegacyArtifactIgnores(root);
  try {
    const git = openRepo(root);
    const remotes = await git.getRemotes();
    if (!remotes.some((r) => r.name === "origin")) return { converged: false, problem: null };
    const branch = (await git.status()).current ?? "main";
    await git.fetch("origin", branch);
    const before = await git.revparse(["HEAD"]).catch(() => "");
    try {
      await git.raw(["merge", "--ff-only", `origin/${branch}`]);
    } catch (e) {
      const problem = `cannot fast-forward from origin/${branch}: ${(e as Error).message}`;
      log.warn("sync", `${root}: ${reason} — ${problem} (local branch diverged or working tree blocks it; not touching a user's repo)`);
      return { converged: false, problem };
    }
    const after = await git.revparse(["HEAD"]).catch(() => "");
    if (before !== after) {
      log.info("sync", `${root}: ${reason} — fast-forwarded to origin/${branch}; another computer's finished work is now visible here`);
      return { converged: true, problem: null };
    }
    return { converged: false, problem: null }; // already current
  } catch (e) {
    const problem = `converge failed: ${(e as Error).message}`;
    log.warn("sync", `${root}: ${reason} — ${problem}`);
    return { converged: false, problem };
  }
}

// Page-load convergence trigger — same idiom as scan-job's `maybeTriggerStaleScan` and
// backbone-freshness's `maybeSyncBackbone`: non-blocking, single-flight per repo, throttled, never throws.
const CONVERGE_THROTTLE_MS = 30 * 60 * 1000; // 30 min — a fetch per repo is cheap but not free
const lastConvergeAt = new Map<string, number>();
const inFlight = new Set<string>();

/** Kick a background fetch + ff-only converge for a tracked working repo, at most every 30 min. */
export function maybeConvergeWorkingRepo(repoRoot: string, reason: string): void {
  try {
    const root = path.resolve(expandHome(repoRoot));
    if (inFlight.has(root)) return;
    const last = lastConvergeAt.get(root) ?? 0;
    if (Date.now() - last < CONVERGE_THROTTLE_MS) return;
    // Cheap disk gate before any git spawn: only repos where LFB artifacts are in play.
    if (!fs.existsSync(path.join(root, LFBRIDGE_DIR)) && !hasDurableArtifact(root)) return;
    lastConvergeAt.set(root, Date.now());
    inFlight.add(root);
    void convergeWorkingRepoFromOrigin(root, reason)
      .catch((e) => log.warn("sync", `${root}: background converge crashed: ${(e as Error).message}`))
      .finally(() => inFlight.delete(root));
  } catch {
    /* a freshness trigger must never break the page it fires from */
  }
}
