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
import {
  buildDiscoveryCtx,
  discoverForeignPin,
  recordForeignPin,
  verifyForeignPins,
  flushForeignPinStores,
  type DiscoveryCtx,
} from "../ipfs/foreign-pin.service.js";
import { compressInfo } from "../fs/badges.js";
import { readYaml, writeYaml } from "../../shared/store/yaml-store.js";
import { computerUnitDir, unitConfigPath, unitStatusPath } from "../../shared/store/scopes.js";
import { HARD_SKIP, isMacPackageDir, isMediaFile, isAnalysisCandidate, isTransientDownloadFile } from "../../shared/scan-filters.js";
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

  // Foreign Pin Discovery context (foreign_pin_discovery.mdx §3) — the kept-set (pins ∪ MFS roots) + the
  // size-prune index, built ONCE for the whole scan and threaded into every repo's external-state pass so
  // an UNDECIDED file already pinned OUTSIDE us (a bare `ipfs add`, another tool) is discovered, size-pruned
  // and cached. Built only when the node is reachable (pinset non-empty); when down we skip discovery AND
  // skip verify, so a node-down scan never wipes previously-recorded discoveries.
  let discovery: DiscoveryCtx | undefined;
  if (pinset.size > 0) {
    discovery = await buildDiscoveryCtx();
    try {
      verifyForeignPins(discovery.keptSet); // drop discoveries another tool has since unpinned (§5.1)
    } catch (e) {
      log.debug("scan", `verifyForeignPins skipped: ${(e as Error).message}`);
    }
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
    const { candidates, dropped } = await walkUnit(repoPath, threshold, {
      ignore: ig,
      includeGlobs: rc.large_files.include_globs,
      excludeGlobs: rc.large_files.exclude_globs,
      maskPaths: [],
      // Never let the nudge gate exceed the payload gate — a per-repo big_file_override that lowers
      // `threshold` below the global 50 MB would otherwise nudge on files it also treats as payload.
      checkedInThreshold: Math.min(cfg.big_file.checked_in_threshold_bytes, threshold),
    });
    const status = writeStatus(folder, "repo", candidates, threshold, source, dropped);

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
      const extCtx: ExternalStateCtx = {
        pinset,
        cidForPath: (rel) => cidByPath.get(rel) ?? null,
        repoRoot: repoPath,
        discovery,
      };
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

  // The foreign-pin stores are WRITE-BACK (foreign-pin.service.ts): the per-file loop mutates them in
  // memory and a debounce coalesces the writes, because rewriting a 3.9 MB JSON once per scanned file is
  // what drove RSS to 4 GB on 2026-07-20. A scan is the natural commit point — write them through here so
  // this pass's discoveries are durable the moment it reports complete, not two seconds later.
  flushForeignPinStores();

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
    // Each root gets what remains of BOTH budgets (soft and hard), so the totals — not the per-root
    // counts — are what the caps bound (2_2_do §I item I4, scan.mdx §4.5).
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
      Math.max(0, UNIT_CANDIDATE_CAP - all.length),
      Math.max(0, UNIT_CANDIDATE_HARD_CAP - all.length),
    );
    for (const c of res.candidates) all.push(c);
    dropped += res.dropped;
  }
  if (dropped > 0) {
    log.warn(
      "scan",
      `computer unit hit the ${UNIT_CANDIDATE_HARD_CAP}-candidate hard cap across ${scanRoots.length} root(s) — ${dropped} candidate(s) dropped`,
    );
  }
  const dir = computerUnitDir();
  const prev = readYaml(unitStatusPath(dir), UnitStatusSchema);
  const next = diffStatus(prev, all, globalThreshold, source, "computer", dropped);
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
// NO SILENT TRUNCATION (charter): on hitting the hard cap we keep WALKING and keep COUNTING — we just
// stop PUSHING — so the warning we log (and the `scan_dropped_candidates` count we persist to the unit's
// status.yaml) carries the exact number of candidates dropped, not a vague "some". Reported via log.warn
// to the durable fault trail, exactly how tracking.service reports its MAX_FILES cap.
// THE SOFT CAP IS A HEADS-UP, NOT A LIMIT. It must sit far above what a legitimate tree produces, or the
// WARN fires on every scheduled scan of a perfectly normal repo and becomes noise nobody reads (the
// real-world case: UAP_Murder_Docus, 5,364 genuine media/PDF candidates — no junk in the count at all —
// warned every 15 minutes under the old 5,000 soft cap and, before the headroom existed, silently dropped
// 364 of them on EVERY scan). 50,000 is ~10× the largest tree observed on this machine, so crossing it
// means a tree is genuinely heading somewhere unusual and deserves a look.
const UNIT_CANDIDATE_CAP = 50_000;

// NO PERMANENT BLINDNESS (scan.mdx §4.5): the cap is a SOFT bound with bounded headroom, not a cliff. A
// unit that lands over the soft cap used to drop the SAME overflow files on EVERY scan — a stable set of
// files silently invisible to the product forever, because nothing ever picked up the remainder. The walk
// order is deterministic, so a fixed cap converts a one-scan memory guard into a permanent censorship of
// the tail.
//
// THE HARD CAP IS A CRASH BACKSTOP, NOT A ROUTINE BOUND. It exists only so a pathological tree (a runaway
// generated directory, a mounted archive) can't OOM the web-app process — it must never be reached by a
// real user directory. Sizing: a persisted candidate row measures ~150 B in status.yaml (measured: 804 KB
// for 5,364 rows) and ~250 B live, so 200,000 rows is ~30 MB of YAML and ~50 MB of heap in the absolute
// worst case — bounded, while being ~37× the largest tree we have ever observed. Only past this ceiling do
// we drop, and then the exact count is persisted (`scan_dropped_candidates`) and surfaced in the UI, so a
// truncated census is never presented as authoritative.
const UNIT_CANDIDATE_HARD_CAP = 200_000;

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

// Recursive stat-only walk. Returns files >= threshold that pass the ignore/mask rules. `cap` is the
// SOFT bound (default UNIT_CANDIDATE_CAP) — exceeding it only logs; rows are dropped (with an exact
// count) only past `hardCap` (default UNIT_CANDIDATE_HARD_CAP) — see the constants for why the walk
// keeps going past both (2_2_do §I item I4, scan.mdx §4.5).
async function walkUnit(
  root: string,
  threshold: number,
  opts: WalkOpts,
  cap: number = UNIT_CANDIDATE_CAP,
  hardCap: number = UNIT_CANDIDATE_HARD_CAP,
): Promise<WalkResult> {
  const out: Candidate[] = [];
  let dropped = 0;
  const stack: string[] = [root];
  const excl = ignore().add(opts.excludeGlobs);
  const incl = opts.includeGlobs.length ? ignore().add(opts.includeGlobs) : null;
  // Can an excluded directory be PRUNED (not descended at all)? Only when no exclude pattern is a
  // NEGATION — a `!keep/big.mp4` re-includes something under an otherwise-excluded tree, and pruning the
  // tree would skip it. Without negations, "everything under this dir is excluded" is decidable.
  const exclHasNegation = opts.excludeGlobs.some((g) => g.trimStart().startsWith("!"));
  // True when `relDir` is excluded as a whole. Three probes, because the gitignore grammar spells the
  // same intent three ways and `ignores()` is literal about it: `foo` matches the bare path, `foo/`
  // matches only the trailing-slash form, and `foo/**` matches NEITHER — it matches only paths INSIDE,
  // which the probe child covers. All three mean "don't walk in here".
  const dirIsExcluded = (relDir: string): boolean =>
    excl.ignores(relDir) ||
    excl.ignores(relDir + "/") ||
    (!exclHasNegation && excl.ignores(relDir + "/.lfb-prune-probe"));
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
        // PRUNE THE SUBTREE, don't filter its files one by one. The unit's `exclude_globs` used to be
        // tested only on FILES (below), so an excluded directory was still descended into in full — every
        // file inside it stat'd and matched before being thrown away. Pruning here means an excluded tree
        // costs nothing and can never consume the candidate budget.
        const relDir = path.relative(root, abs);
        if (relDir && dirIsExcluded(relDir)) continue;
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      // A downloader's in-flight temp file (yt-dlp fragment, browser .part, ffmpeg fixup temp) is gone
      // seconds after it appears — indexing it creates a row that outlives the file (scan.mdx §4.3.1).
      if (isTransientDownloadFile(ent.name)) continue;
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
      // At the HARD cap: stop accumulating, but keep counting so the warning below (and the persisted
      // scan_dropped_candidates) is exact (§I item I4, scan.mdx §4.5). The soft `cap` never drops —
      // it only marks the walk as over-budget in the log so a growing tree is noticed before it
      // reaches the ceiling.
      if (out.length >= hardCap) {
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
      `walk of ${root} hit the ${hardCap}-candidate hard cap — ${dropped} candidate(s) dropped from this unit's scan (recorded on the unit's status as scan_dropped_candidates)`,
    );
  } else if (out.length > cap) {
    // Over the soft cap but inside the headroom: NOTHING was dropped — the census is complete. Logged so
    // a tree drifting toward the hard ceiling is visible before truncation ever starts (scan.mdx §4.5).
    log.warn(
      "scan",
      `walk of ${root} exceeded the ${cap}-candidate soft cap (${out.length} candidates kept within the ${hardCap} headroom — nothing dropped)`,
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
  dropped = 0,
): UnitStatus {
  const prev = getRepoStatus(folder);
  const next = diffStatus(prev, candidates, threshold, source, "repo", dropped);
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
  repoRoot?: string; // absolute repo root — for foreign-pin discovery's abs path (foreign_pin_discovery.mdx §3)
  discovery?: DiscoveryCtx; // the kept-set + size-prune index; present only when the node is reachable (§3)
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
  let pinnedCid = cid != null && ctx.pinset.has(canonicalCid(cid)) ? cid : null;
  let pinProfile: string | undefined; // which ADD_PROFILES entry reproduced a foreign pin (null = manifest CID)

  // FOREIGN PIN DISCOVERY (foreign_pin_discovery.mdx §3): a file with no pinned manifest CID may STILL be
  // pinned — under a CID some OTHER tool created (a bare `ipfs add` → `Qm…`, a different DAG profile, MFS).
  // Probe it, but BOUNDED: only when the node is reachable and the size-prune admits it, and cached so an
  // unchanged file is never re-hashed. This is the background pass paying the hash once (never on a read).
  if (!pinnedCid && ctx.discovery && ctx.discovery.keptSizes.length > 0 && ctx.repoRoot) {
    const abs = path.join(ctx.repoRoot, file.path);
    const mtimeMs = file.modified ? Date.parse(file.modified) : 0;
    try {
      const hit = await discoverForeignPin(abs, file.size, mtimeMs, ctx.discovery);
      if (hit) {
        pinnedCid = hit.cid;
        pinProfile = hit.profile;
        // Global index (tier-1 fast UI lookup — §5/§6): record so the repo row (pinnedForeign) and the IPFS
        // page (reverse resolution) surface it cheaply without re-hashing. Idempotent upsert keyed by path.
        recordForeignPin({ cid: hit.cid, profile: hit.profile, absPath: abs, size: file.size, repoRoot });
      }
    } catch (e) {
      log.debug("scan", `foreign-pin discovery skipped for ${abs}: ${(e as Error).message}`);
    }
  }

  const looksCompressed = compressInfo(name).compressState === "done";
  if (!pinnedCid && !looksCompressed) return; // no external state to record for this file

  // Idempotency guard (§3.3 "recorded once, not every pass"): an existing observed/ipfs_pin event means the
  // external/pin state was already captured — never re-append it on a subsequent scan. Before returning,
  // re-seed the global index from the durable sidecar CID (the index is a rebuildable cache — if it was
  // cleared, a prior discovery still lives in the travelling sidecar, so heal it here — §5/§6).
  const existing = readSidecar(repoRoot, file.path);
  const prior = existing?.file.events.find((e) => e.kind === "observed" || e.kind === "ipfs_pin");
  if (prior) {
    const priorCid = (prior as { ipfs?: { cid?: string } }).ipfs?.cid;
    if (priorCid && ctx.repoRoot && ctx.discovery?.keptSet.has(canonicalCid(priorCid))) {
      recordForeignPin({
        cid: priorCid,
        profile: (prior as { ipfs?: { profile?: string } }).ipfs?.profile ?? "recorded",
        absPath: path.join(ctx.repoRoot, file.path),
        size: file.size,
        repoRoot,
      });
    }
    return;
  }

  const event: FileEventInput = { kind: "observed", by: NOT_LFBRIDGE };
  const notes: string[] = [];
  if (pinnedCid) {
    event.ipfs = { pinned: true, cid: pinnedCid, ...(pinProfile ? { profile: pinProfile } : {}) };
    notes.push(
      pinProfile
        ? `already pinned on this computer's IPFS node (discovered under profile ${pinProfile}, outside Large File Bridge)`
        : "already pinned on this computer's IPFS node",
    );
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
  dropped = 0,
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
    // Truncation is a per-scan fact — always overwrite (never inherit prev's via the spread above), and
    // `undefined` when 0 so YAML.stringify omits the key from a complete census (scan.mdx §4.5).
    scan_dropped_candidates: dropped > 0 ? dropped : undefined,
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
