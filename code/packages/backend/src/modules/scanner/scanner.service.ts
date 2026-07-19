// The scan (scan.mdx): metadata-only discovery. Stat big files; never open/read/hash them.
// Runs the whole-filesystem discovery walk that feeds the Repos/Scans UI.
import fs from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import {
  UnitStatusSchema,
  ComputerUnitConfigSchema,
  type UnitStatus,
} from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import {
  listRepoFolders,
  getRepoConfig,
  getRepoStatus,
  writeRepoStatus,
  registerRepo,
  isGitWorkingTree,
} from "../store-model/units.service.js";
import { reconcile as reconcileDecisions, applyDefaultPolicy } from "../storage/decisions.service.js";
import { refreshCounts } from "../storage/repo-storage.service.js";
import {
  readSidecar,
  appendFileEvent,
  NOT_LFBRIDGE,
  type FileEventInput,
} from "../storage/file-sidecar.service.js";
import { readCommittedManifest } from "../pin/manifest.service.js";
import { listPins, canonicalCid } from "../ipfs/ipfs.service.js";
import { compressInfo } from "../fs/badges.js";
import { readYaml, writeYaml } from "../../shared/store/yaml-store.js";
import { computerUnitDir, unitConfigPath, unitStatusPath } from "../../shared/store/scopes.js";
import { HARD_SKIP, isMacPackageDir, isMediaFile, isAnalysisCandidate } from "../../shared/scan-filters.js";
import { mapLimit, responsiveBudget } from "../../shared/concurrency.js";
import { log } from "../../shared/logging.js";

interface Candidate {
  path: string; // relative to unit root
  size: number;
  modified_at: string;
  // TRUE when this row is NOT bridge payload — the checked-in nudge (scan.mdx §4.1 rule 4) OR small
  // analysis media (rule 5). In-memory only: writeStatus() does not persist it, because its only job is to
  // keep the auto-decide policy off these rows in the SAME scan pass (§4.1 "a nudge, not payload").
  nudgeOnly?: boolean;
  // TRUE when this row was admitted ONLY as small, not-git-ignored analysis media (scan.mdx §4.1 rule 5) —
  // a sub-threshold image/video/audio surfaced purely so the analysis tabs can OCR / describe / transcribe
  // it. Unlike `nudgeOnly`, this IS persisted to status.yaml, because the frontend "Large files only" rail
  // toggle (tables.mdx §2.9) reads it off each FileRow long after the scan. A rule-5 row carries BOTH flags.
  analysisOnly?: boolean;
}

// Progress reporter threaded through the walk so the background job runner (scan-job.ts) can surface
// live progress to the web app. Every method is optional in spirit — a no-op sink runs a silent scan.
export interface ProgressSink {
  setPhase(phase: "idle" | "discovering" | "repos" | "computer" | "done"): void;
  setReposTotal(n: number): void;
  unitStart(name: string): void;
  unitDone(candidatesInUnit: number): void;
}

const NOOP_SINK: ProgressSink = {
  setPhase() {},
  setReposTotal() {},
  unitStart() {},
  unitDone() {},
};

export async function scanAll(
  source: "scheduled" | "manual" = "scheduled",
  progress: ProgressSink = NOOP_SINK,
): Promise<void> {
  const cfg = getAppConfig();
  const roots = cfg.scanner.roots.map(expandHome).filter((r) => safeIsDir(r));
  log.info("scan", `Scan (${source}) starting over ${roots.length} root(s).`);

  // 1. Repo discovery — register any .git working tree found under the roots. The independent per-root
  // discovery walks fan out at the RESPONSIVE budget (cores − 2, parallelization.mdx §3) so many roots are
  // walked at once; each walk still yields to the event loop (§10) so the app stays responsive.
  progress.setPhase("discovering");
  const discovered = new Set<string>();
  const perRoot = await mapLimit(roots, responsiveBudget(), (root) =>
    findGitRepos(root, cfg.scanner.follow_symlinks),
  );
  for (const list of perRoot) for (const repoPath of list) discovered.add(repoPath);
  for (const repoPath of discovered) {
    try {
      await registerRepo(repoPath);
    } catch (e) {
      // already registered or not a working tree — fine; keep a debug crumb in case it was a real fault.
      log.debug("scan", `registerRepo(${repoPath}) skipped: ${(e as Error).message}`);
    }
  }

  // 2. Build the mask: every registered repo working-tree path.
  const repoFolders = listRepoFolders();
  const repoPaths: string[] = [];
  for (const folder of repoFolders) {
    const rc = getRepoConfig(folder);
    if (rc.repo.path) repoPaths.push(path.resolve(expandHome(rc.repo.path)));
  }

  // 3. Scan each repo unit. +1 for the computer unit walked in step 4.
  // The independent repo-unit walks run IN PARALLEL, bounded by the RESPONSIVE budget (cores − 2,
  // parallelization.mdx §3) — many stat-only walks at once instead of one-repo-after-another. Each walk
  // still yields to the event loop (§10) so the HTTP server never freezes, and each unit's status.yaml is
  // written atomically (storage_local.mdx §15), so concurrent unit walks never collide.
  progress.setPhase("repos");
  progress.setReposTotal(repoFolders.length + 1);

  // Fetch the IPFS pinset ONCE for the whole scan (the node is machine-wide — every repo's pins live in the
  // same pinset), build a CID Set, and reuse it across every repo's count rollup + external-state pass so
  // we never re-query the node per repo or per file (repo_tracking_scheme.mdx §3.3, PERFORMANCE). The daemon
  // being off is routine — best-effort, an empty pinset just means "nothing observed as already pinned."
  // CANONICAL (CIDv1 base32) keys (knowledge/ipfs.mdx §5.1): `ipfs pin ls` is base-sensitive, so a raw
  // string Set went blind to a block pinned as `Qm…` when the manifest recorded its `bafy…` form. Every
  // membership test below canonicalizes the queried CID too.
  let pinset = new Set<string>();
  try {
    pinset = new Set((await listPins()).map((p) => canonicalCid(p.cid)));
  } catch (e) {
    log.debug("scan", `pinset fetch skipped (node unreachable?): ${(e as Error).message}`);
  }

  await mapLimit(repoFolders, responsiveBudget(), async (folder) => {
    const rc = getRepoConfig(folder);
    progress.unitStart(rc.repo.name || folder);
    const repoPath = rc.repo.path ? path.resolve(expandHome(rc.repo.path)) : "";
    if (!repoPath || !isGitWorkingTree(repoPath)) {
      const st = getRepoStatus(folder);
      writeRepoStatus(folder, { ...st, repo_state: "missing" });
      progress.unitDone(0);
      return;
    }
    const threshold = resolveThreshold(rc.big_file_override, cfg.big_file.threshold_bytes);
    const ig = rc.large_files.follow_gitignore ? buildRepoIgnore(repoPath) : null;
    // ig === null means "no real .gitignore to follow" → size-gate only, no media-bypass.
    const { candidates } = await walkUnit(repoPath, threshold, {
      ignore: ig,
      includeGlobs: rc.large_files.include_globs,
      excludeGlobs: rc.large_files.exclude_globs,
      maskPaths: [],
      // Never let the nudge gate exceed the payload gate — a per-repo big_file_override that lowers
      // `threshold` below the global 50 MB would otherwise nudge on files it also treats as payload.
      checkedInThreshold: Math.min(cfg.big_file.checked_in_threshold_bytes, threshold),
    });
    const status = writeStatus(folder, "repo", candidates, threshold, source);

    // Map each candidate's repo-relative path to the CID the committed manifest recorded for it, so we can
    // tell — cheaply, reusing the ONE pinset fetched for this whole scan — which candidates are already
    // pinned on THIS node (by us OR pinned on the CLI outside us). One manifest read per repo, no per-file
    // node query (special_files.mdx §4 / repo_tracking_scheme.mdx §3.3).
    let cidByPath = new Map<string, string | null>();
    try {
      cidByPath = new Map(readCommittedManifest(repoPath).files.map((f) => [f.path, f.cid]));
    } catch (e) {
      log.debug("scan", `manifest read skipped (${repoPath}): ${(e as Error).message}`);
    }
    const isPinnedPath = (rel: string): boolean => {
      const cid = cidByPath.get(rel);
      return cid != null && pinset.has(canonicalCid(cid)); // canonical: a `Qm…` pin of a `bafy…` CID counts
    };

    // (1) Roll the special-file counts + last_scan into .lfbridge/repo_storage.yaml (special_files.mdx §4).
    // `headless` = a background/scheduled scan (vs. a manual web-app scan). Best-effort — a write failure
    // must never abort the scan.
    try {
      refreshCounts(
        repoPath,
        candidates.map((c) => ({ path: c.path, size: c.size, pinned: isPinnedPath(c.path) })),
        { thresholdBytes: threshold, headless: source === "scheduled" },
      );
    } catch (e) {
      log.debug("scan", `refreshCounts(${repoPath}) skipped: ${(e as Error).message}`);
    }

    // (2) Record external state a scan OBSERVED but LFB did not create — files already IPFS-pinned or
    // already-compressed OUTSIDE us — as a once-per-file `observed`/not-lfbridge sidecar event
    // (repo_tracking_scheme.mdx §3.3). Reuses the single pinset + the manifest CID map; idempotent per file.
    try {
      const extCtx: ExternalStateCtx = { pinset, cidForPath: (rel) => cidByPath.get(rel) ?? null };
      for (const c of candidates) {
        await reconcileExternalState(
          repoPath,
          { path: c.path, size: c.size, modified: c.modified_at },
          extCtx,
        );
      }
    } catch (e) {
      log.debug("scan", `reconcileExternalState(${repoPath}) skipped: ${(e as Error).message}`);
    }

    // Project the SHARED decision ledger (any teammate/other-computer decisions a git pull delivered)
    // onto this machine's frozen decisions: enum cache (decisions.mdx §7). Best-effort — a bad ledger
    // must never abort the scan.
    try {
      await reconcileDecisions(folder);
    } catch (e) {
      log.debug("scan", `reconcileDecisions(${folder}) skipped: ${(e as Error).message}`);
    }

    // (3) Apply the shared default-decision policy to BRAND-NEW candidates (this scan's `added` set) that
    // have no folded decision yet (decisions.mdx §9). The shared policy defaults to OFF, so this is a no-op
    // unless a team deliberately opted into auto-decide. Best-effort.
    try {
      // Nudge-only rows (scan.mdx §4.1 rule 4) are EXCLUDED from the policy. They are checked-in files we
      // surface as a git-hygiene warning; they are not payload. Letting an `auto` policy decide them would
      // auto-pin a file to IPFS that the user never chose to bridge (and auto-writing a .gitignore entry is
      // forbidden outright by the charter). Both axes stay Undecided until the user clicks. Without this
      // filter, admitting these candidates would have silently widened what auto-decide can publish.
      const nudgeOnly = new Set(candidates.filter((c) => c.nudgeOnly).map((c) => c.path));
      const added = status.changes_since_last_scan.added.filter((p) => !nudgeOnly.has(p));
      if (added.length) {
        const { autoDecided } = await applyDefaultPolicy(folder, added);
        if (autoDecided > 0) {
          log.info("scan", `${folder}: ${autoDecided} new file(s) auto-decided by policy.`);
        }
      }
    } catch (e) {
      log.debug("scan", `applyDefaultPolicy(${folder}) skipped: ${(e as Error).message}`);
    }

    progress.unitDone(candidates.length);
  });

  // 4. Scan the computer unit (roots minus the repo mask).
  progress.setPhase("computer");
  progress.unitStart("computer");
  const computerCount = await scanComputerUnit(
    roots,
    repoPaths,
    cfg.big_file.threshold_bytes,
    source,
  );
  progress.unitDone(computerCount);

  // TO DO recalc stage (to_do_batch_calc_engine.mdx §1): with discovery + classification done, rebuild
  // the per-storage recommendation batches that power the To Do page slugs and most warnings. Imported
  // lazily to avoid any static import cycle; best-effort — it never blocks or fails the scan.
  try {
    const { recalcAll } = await import("../todo/todo-batch.engine.js");
    await recalcAll();
  } catch (e) {
    log.warn("scan", `TO DO recalc stage failed: ${(e as Error).message}`);
  }

  progress.setPhase("done");
  log.info("scan", `Scan (${source}) complete.`);
}

async function scanComputerUnit(
  roots: string[],
  maskPaths: string[],
  globalThreshold: number,
  source: "scheduled" | "manual",
): Promise<number> {
  const cc = readYaml(unitConfigPath(computerUnitDir()), ComputerUnitConfigSchema);
  const scanRoots = (cc.roots.length ? cc.roots.map(expandHome) : roots).filter(safeIsDir);
  // The computer unit concatenates one walk per root, so the cap has to apply to the TOTAL, not per
  // root — otherwise N roots would hold N × the cap (2_2_do §I item I4). Each root gets whatever the
  // budget has left; a root that exhausts it still counts (and warns about) what it dropped.
  const all: Candidate[] = [];
  let dropped = 0;
  for (const root of scanRoots) {
    const res = await walkUnit(
      root,
      globalThreshold,
      {
        ignore: null,
        includeGlobs: [],
        excludeGlobs: cc.exclude_globs,
        maskPaths,
        rootLabelAbsolute: true,
      },
      UNIT_CANDIDATE_CAP - all.length,
    );
    for (const c of res.candidates) all.push(c);
    dropped += res.dropped;
  }
  if (dropped > 0) {
    log.warn(
      "scan",
      `computer unit hit the ${UNIT_CANDIDATE_CAP}-candidate cap across ${scanRoots.length} root(s) — ${dropped} candidate(s) dropped`,
    );
  }
  const dir = computerUnitDir();
  const prev = readYaml(unitStatusPath(dir), UnitStatusSchema);
  const next = diffStatus(prev, all, globalThreshold, source, "computer");
  writeYaml(unitStatusPath(dir), { ...next });
  return all.length;
}

interface WalkOpts {
  ignore: Ignore | null;
  includeGlobs: string[];
  excludeGlobs: string[];
  maskPaths: string[];
  rootLabelAbsolute?: boolean;
  // The checked-in nudge gate (scan.mdx §4.1 rule 4). Set ONLY for repo units — the computer unit has no
  // git working tree, so "checked in" is meaningless there and it stays on the pure size gate.
  checkedInThreshold?: number;
}

// The most candidate rows one unit walk will hold in memory (2_2_do §I item I4). Matches the house
// number used by the other two walks — fsindex.service FLAT_FILE_CAP and tracking.service MAX_FILES,
// both 5000 — so all three bound the same way. Without it `out` was the one unbounded accumulator here,
// and scanComputerUnit then concatenated one per root, multiplying it.
//
// NO SILENT TRUNCATION (charter): on hitting the cap we keep WALKING and keep COUNTING — we just stop
// PUSHING — so the warning we log carries the exact number of candidates dropped, not a vague "some".
// That also keeps this a memory-only fix: the walk covers the same tree it always did, so nothing about
// which files are discovered changes below the cap. Reported via log.warn to the durable fault trail,
// exactly how tracking.service reports its MAX_FILES cap. (UnitStatus has no truncation field and
// adding one would change the on-disk format.)
const UNIT_CANDIDATE_CAP = 5000;

// Yield control back to the event loop so a long, CPU-bound synchronous walk does not FREEZE the whole
// web app. The walk is fs.readdirSync/statSync in a tight loop; without cooperative yields it starves
// the HTTP server for the whole scan — scan-status polls, page loads, everything hangs, which reads as
// "the scan (and the app) stopped." Yielding every few hundred entries keeps the server responsive
// while the scan runs truly in the background (scan.mdx §10).
const YIELD_EVERY = 400;
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** What one unit walk found: the (capped) candidate rows, plus how many the cap dropped. */
interface WalkResult {
  candidates: Candidate[];
  dropped: number;
}

// Recursive stat-only walk. Returns files >= threshold that pass the ignore/mask rules, capped at
// `cap` rows (default UNIT_CANDIDATE_CAP) with an exact count of what the cap dropped — see the
// constant for why we keep walking past it (2_2_do §I item I4).
async function walkUnit(
  root: string,
  threshold: number,
  opts: WalkOpts,
  cap: number = UNIT_CANDIDATE_CAP,
): Promise<WalkResult> {
  const out: Candidate[] = [];
  let dropped = 0;
  const stack: string[] = [root];
  const excl = ignore().add(opts.excludeGlobs);
  const incl = opts.includeGlobs.length ? ignore().add(opts.includeGlobs) : null;
  let sinceYield = 0;

  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // Unreadable dir (permissions, vanished mid-walk) — skip its subtree; routine, so debug only.
      log.debug("scan", `readdir skipped ${dir}: ${(e as Error).message}`);
      continue;
    }
    if ((sinceYield += entries.length) >= YIELD_EVERY) {
      sinceYield = 0;
      await yieldToLoop();
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (opts.maskPaths.some((m) => abs === m || abs.startsWith(m + path.sep))) continue;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (HARD_SKIP.has(ent.name) || isMacPackageDir(ent.name)) continue; // bundles are opaque
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = path.relative(root, abs);
      const relForIgnore = opts.rootLabelAbsolute ? abs : rel;
      if (excl.ignores(rel)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(abs); // metadata only — never open the file (scan.mdx §1)
      } catch (e) {
        // File vanished or is unstattable between readdir and stat — skip it; routine, debug only.
        log.debug("scan", `stat skipped ${abs}: ${(e as Error).message}`);
        continue;
      }
      const bigEnough = st.size >= threshold;
      const forced = incl?.ignores(rel) ?? false;
      // Is a repo .gitignore being followed, and does THIS file match it? A real gitignore
      // hit means the user deliberately kept the file out of git — LFBridge's whole domain.
      const gitIgnored = opts.ignore ? opts.ignore.ignores(rel) : false;
      const followsGitignore = opts.ignore != null;
      // THE FIX (scan.mdx §4.1): a git-ignored *media* file is a large-file-bridge payload
      // regardless of the big-file size threshold. Videos/audio/images excluded from git are
      // exactly what we pin over IPFS; the 100 MB threshold must not hide the 5–100 MB ones.
      // Non-media git-ignored files (and the computer unit, which has no gitignore) still use
      // the pure size gate, so junk (.env, logs) and generic files aren't swept in.
      const gitIgnoredMedia = gitIgnored && isMediaFile(ent.name);
      // THE CHECKED-IN NUDGE (scan.mdx §4.1 rule 4): a file that is NOT git-ignored and is over the
      // checked-in threshold is a candidate too — the charter's "big files that aren't a good idea to
      // check in" category. Without this the `bigNotIgnored` metric and the one-click ⊘ offer were dead
      // code: a row could only exist if git ignored it, so "big AND not ignored" could never be counted.
      // Deliberately lower than `threshold` (50 MB vs 100 MB) so we warn before GitHub blocks the push.
      // These rows are a NUDGE, never bridge payload — the user's ⊘ click is what makes them ours.
      const checkedInBig =
        opts.checkedInThreshold != null && !gitIgnored && st.size >= opts.checkedInThreshold;
      // THE ANALYSIS-CANDIDATE RULE (scan.mdx §4.1 rule 5): a video/audio/image OR a PDF at ANY size is a
      // candidate — even a small, checked-in, not-git-ignored one (a 2 MB screenshot, a 30-second clip, a
      // one-page contract PDF) — so the analysis tabs can OCR / describe / transcribe it. This is what lets
      // "open the OCR tab and OCR a file smaller than the large-file size" work; without it the small file is
      // never a row. PDFs join here (not isMediaFile) because they are an OCR target but NOT pin payload
      // (ocr.mdx §1.7.1) — isAnalysisCandidate = media OR pdf.
      // REPO UNITS ONLY (gated on the same `checkedInThreshold` signal as rule 4): the computer unit walks
      // ALL of home, where admitting every tiny icon/thumbnail would flood the census — a repo is the
      // bounded, intentional scope where OCR-a-small-file is the real workflow.
      const analysisMedia = opts.checkedInThreshold != null && isAnalysisCandidate(ent.name);
      // Payload = what this file would have been WITHOUT the nudge/analysis rules. A row that is only a
      // candidate because of `checkedInBig` or `analysisMedia` is NOT payload — the auto-decide policy must
      // never touch it (it would auto-pin a file the user never chose to bridge).
      const isPayload =
        forced || gitIgnoredMedia || (bigEnough && (followsGitignore ? gitIgnored : true));
      const isCandidate = isPayload || checkedInBig || analysisMedia;
      if (!isCandidate) continue;
      // `analysisOnly` = admitted PURELY by rule 5 (not payload, not the checked-in nudge) — a small media
      // file. It is what the "Large files only" toggle hides (tables.mdx §2.9). A git-ignored media file of
      // any size (rule 1, payload) or a 50–100 MB checked-in nudge (rule 4) is NOT analysisOnly, so it stays
      // visible under the toggle — the 5–100 MB git-ignored clip case (scan.mdx §4.1) is never re-hidden.
      const analysisOnly = !isPayload && !checkedInBig && analysisMedia;
      // At the cap: stop accumulating, but keep counting so the warning below is exact (§I item I4).
      if (out.length >= cap) {
        dropped++;
        continue;
      }
      out.push({
        path: opts.rootLabelAbsolute ? abs : rel,
        size: st.size,
        modified_at: st.mtime.toISOString(),
        // nudgeOnly keeps the auto-decide policy off every non-payload row (checked-in nudge OR analysis
        // media); analysisOnly additionally marks the rule-5-only rows for the "Large files only" toggle.
        ...(isPayload ? {} : { nudgeOnly: true }),
        ...(analysisOnly ? { analysisOnly: true } : {}),
      });
      void relForIgnore;
    }
  }
  if (dropped > 0) {
    log.warn(
      "scan",
      `walk of ${root} hit the ${cap}-candidate cap — ${dropped} candidate(s) dropped from this unit's scan`,
    );
  }
  return { candidates: out, dropped };
}

function writeStatus(
  folder: string,
  _unit: "repo" | "computer",
  candidates: Candidate[],
  threshold: number,
  source: "scheduled" | "manual",
): UnitStatus {
  const prev = getRepoStatus(folder);
  const next = diffStatus(prev, candidates, threshold, source, "repo");
  next.folder_name = folder;
  writeRepoStatus(folder, next);
  return next; // the caller reads changes_since_last_scan.added to drive the default-decision policy pass
}

// ── external-state reconciliation (repo_tracking_scheme.mdx §3.3) ─────────────

/** The cheap context `reconcileExternalState` reasons over — the ONE IPFS pinset fetched per scan, plus a
 *  manifest-backed path→CID lookup — so it never re-queries the node or re-reads the manifest per file. */
export interface ExternalStateCtx {
  pinset: Set<string>; // CANONICAL (CIDv1 base32) CIDs pinned on THIS computer's node (fetched once per scan)
  cidForPath: (relPath: string) => string | null; // repo-relative path → its committed-manifest CID (or null)
}

/**
 * Record state a scan OBSERVED but LFB did not create (repo_tracking_scheme.mdx §3.3): a special file that
 * is ALREADY IPFS-pinned on this node (its committed-manifest CID is in the pinset) OR already LOOKS
 * compressed, with NO prior LFB record. Appends exactly ONE `observed` event stamped `by: not-lfbridge`
 * (on_device defaults to this computer) carrying the cheap facts it read — the pin CID and/or the
 * compressed size. IDEMPOTENT: an existing `observed`/`ipfs_pin` event means we captured this file's
 * external/pin state already, so we return without re-appending on a later pass. Metadata-only — no decode,
 * no per-file node query (it reuses `ctx.pinset`).
 */
export async function reconcileExternalState(
  repoRoot: string,
  file: { path: string; size: number; name?: string; modified?: string },
  ctx: ExternalStateCtx,
): Promise<void> {
  const name = file.name ?? path.basename(file.path);
  const cid = ctx.cidForPath(file.path);
  // Canonical membership (knowledge/ipfs.mdx §5.1) — record the ORIGINAL manifest CID, test by canonical form.
  const pinnedCid = cid != null && ctx.pinset.has(canonicalCid(cid)) ? cid : null;
  const looksCompressed = compressInfo(name).compressState === "done";
  if (!pinnedCid && !looksCompressed) return; // no external state to record for this file

  // Idempotency guard (§3.3 "recorded once, not every pass"): an existing observed/ipfs_pin event means the
  // external/pin state was already captured — never re-append it on a subsequent scan.
  const existing = readSidecar(repoRoot, file.path);
  if (existing?.file.events.some((e) => e.kind === "observed" || e.kind === "ipfs_pin")) return;

  const event: FileEventInput = { kind: "observed", by: NOT_LFBRIDGE };
  const notes: string[] = [];
  if (pinnedCid) {
    event.ipfs = { pinned: true, cid: pinnedCid };
    notes.push("already pinned on this computer's IPFS node");
  }
  if (looksCompressed) {
    event.compressed = { looks_compressed: true, size: file.size };
    notes.push("already looks compressed");
  }
  event.note = `scan observed outside Large File Bridge: ${notes.join("; ")}`;
  // Seed identity on create-on-first-special (name/size/modified); on_device is stamped by the sidecar writer.
  appendFileEvent(repoRoot, file.path, event, { name, size: file.size, modified: file.modified });
}

// Compare against the previous scan; classify added/grew/shrank/moved/deleted (scan.mdx §6).
function diffStatus(
  prev: UnitStatus,
  candidates: Candidate[],
  threshold: number,
  source: "scheduled" | "manual",
  repoState: "repo" | "computer",
): UnitStatus {
  const prevByPath = new Map(prev.candidates.map((c) => [c.path, c]));
  const nowByPath = new Map(candidates.map((c) => [c.path, c]));
  // Files present under the same path in both scans: added (new path), grew, or shrank.
  const addedPaths: string[] = [];
  const grew: string[] = [];
  const shrank: string[] = [];
  for (const c of candidates) {
    const p = prevByPath.get(c.path);
    if (!p) addedPaths.push(c.path);
    else if (c.size > p.size) grew.push(c.path);
    else if (c.size < p.size) shrank.push(c.path);
  }
  const deletedPaths: string[] = [];
  for (const p of prev.candidates) if (!nowByPath.has(p.path)) deletedPaths.push(p.path);

  // Move/rename detection (scan.mdx §6 / AC #7): a file that vanished at path A and reappeared at
  // path B with the SAME size and mtime is a MOVE, not a delete+add — so the pin pass keeps the existing
  // pin instead of re-adding bytes. Pure metadata heuristic (size+mtime); never hashes content (§1).
  const moved: Array<{ from: string; to: string }> = [];
  const sig = (c: { size: number; modified_at?: string }): string => `${c.size}|${c.modified_at ?? ""}`;
  const deletedBySig = new Map<string, string[]>();
  for (const path of deletedPaths) {
    const p = prevByPath.get(path)!;
    if (!p.modified_at) continue; // no mtime → can't safely pair; leave it a plain delete
    const key = sig(p);
    (deletedBySig.get(key) ?? deletedBySig.set(key, []).get(key)!).push(path);
  }
  const pairedDeleted = new Set<string>();
  const pairedAdded = new Set<string>();
  for (const toPath of addedPaths) {
    const c = nowByPath.get(toPath)!;
    if (!c.modified_at) continue;
    const bucket = deletedBySig.get(sig(c));
    const fromPath = bucket?.find((d) => !pairedDeleted.has(d));
    if (!fromPath) continue;
    moved.push({ from: fromPath, to: toPath });
    pairedDeleted.add(fromPath);
    pairedAdded.add(toPath);
  }
  const added = addedPaths.filter((p) => !pairedAdded.has(p));
  const deleted = deletedPaths.filter((p) => !pairedDeleted.has(p));

  return {
    ...prev,
    schema_version: 1,
    last_scan_at: new Date().toISOString(),
    scan_source: source,
    effective_threshold_bytes: threshold,
    // The "big file" totals count only real large-file candidates — small analysis media (rule 5) is NOT a
    // large file and must not inflate the repos-list count/bytes (one_repo.mdx §4.1 / repos.mdx §4.1).
    big_file_count: candidates.filter((c) => !c.analysisOnly).length,
    big_file_bytes: candidates.reduce((s, c) => (c.analysisOnly ? s : s + c.size), 0),
    repo_state: repoState === "computer" ? "present" : "present",
    // Persist analysisOnly (the frontend "Large files only" toggle reads it); path/size/modified_at as before.
    candidates: candidates.map((c) => ({
      path: c.path,
      size: c.size,
      modified_at: c.modified_at,
      ...(c.analysisOnly ? { analysisOnly: true } : {}),
    })),
    changes_since_last_scan: { added, grew, shrank, moved, deleted },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────
export function resolveThreshold(
  override: { enabled: boolean; value: number; unit: "MB" | "GB" | "TB" },
  globalBytes: number,
): number {
  if (!override.enabled) return globalBytes;
  const mult = override.unit === "MB" ? 1024 ** 2 : override.unit === "GB" ? 1024 ** 3 : 1024 ** 4;
  return Math.round(override.value * mult);
}

function buildRepoIgnore(repoPath: string): Ignore | null {
  try {
    const gi = fs.readFileSync(path.join(repoPath, ".gitignore"), "utf8");
    return ignore().add(gi);
  } catch {
    // No .gitignore -> there is no real git-ignore rule to follow. Return null so walkUnit
    // falls back to the pure size gate (every big file is a candidate, as before) and the
    // media-bypass — which requires a genuine gitignore hit — does NOT fire on every file.
    return null;
  }
}

async function findGitRepos(root: string, followSymlinks: boolean): Promise<string[]> {
  const found: string[] = [];
  const stack: string[] = [root];
  let budget = 20000; // bounded walk so discovery never runs away
  let sinceYield = 0;
  while (stack.length && budget-- > 0) {
    const dir = stack.pop()!;
    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;
      await yieldToLoop(); // keep the server responsive during discovery too (scan.mdx §10)
    }
    if (isGitWorkingTree(dir)) {
      found.push(dir);
      continue; // do not descend into a repo to find nested repos (keep it simple)
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // Unreadable dir during git-repo discovery — skip it; routine, so debug only.
      log.debug("scan", `discovery readdir skipped ${dir}: ${(e as Error).message}`);
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (HARD_SKIP.has(ent.name) || isMacPackageDir(ent.name)) continue; // bundles are opaque
      if (ent.isSymbolicLink() && !followSymlinks) continue;
      stack.push(path.join(dir, ent.name));
    }
  }
  return found;
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, process.env.HOME || "~");
}
function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
