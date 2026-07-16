// Transcription service (Transcribe.mdx). Wraps the in-process Transcribe engine (tools/transcribe) with
// LFBridge's storage-aware placement: the transcript is written INSIDE the owning repo/storage's committed
// `.lfbridge/` directory, path-mirrored, under the media's FULL filename with `.transcription` APPENDED as a
// second extension (§3 — a/b/talk.mp3 → <root>/.lfbridge/a/b/talk.mp3.transcription; no .transcribe/ dir).
// Also drives the "Transcribe all files" walks over a directory / repo / storage. Explicit-user-action
// only (§7); reports truthfully per file (§6), and every non-success reaches error.err.
import fs from "node:fs";
import path from "node:path";
import type { TranscribeResult, TranscribeBatchResult, TranscribeTools, TranscriptView, EnqueuePlan, PreviewPlan } from "@lfb/shared";
import { mediaKindForName } from "@lfb/shared";
import { Transcriber } from "../../tools/transcribe/Transcribe.js";
import { transcribeWithEngine, canTranscribe as engineCanTranscribe } from "../../tools/transcribe/engine.js";
import { getAppConfig } from "../store-model/config.service.js";
import { HARD_SKIP } from "../../shared/scan-filters.js";
import { expandHome } from "../fs/badges.js";
import { resolveArtifactPlacement, artifactPathForPlacement, TRANSCRIPTION_EXT } from "../storage/artifact-placement.service.js";
import { markDurableArtifact } from "../storage/tracking-root.service.js";
import { noteArtifactWritten } from "../pin/sync-trigger.service.js";
import { repoArtifactPlacement } from "../store-model/units.service.js";
import { getStorageDetail } from "../storage/storage.service.js";
import { track } from "../progress/progress.registry.js";
import { enqueue } from "../jobqueue/jobqueue.service.js";
import { writeManifest, trackBatch } from "../jobqueue/batch-manifest.service.js";
import { log } from "../../shared/logging.js";
import { txn } from "../../shared/transactions.js";

// The transcript sidecar extension (Transcribe.mdx §3) is TRANSCRIPTION_EXT, imported above.
// Directories a "Transcribe all" walk never descends into: the SAME hard-skip set as the discovery scan
// and FS browser (scan.mdx §4 invariant — build/, dist/, node_modules, … duplicate source media), plus
// the artifact dirs (`.transcribe` kept so legacy trees are skipped).
const SKIP_DIRS = new Set([...HARD_SKIP, ".transcribe", ".lfbridge"]);

const engine = new Transcriber();

// ── transcript-path resolution (§3.4) — delegated to the shared, storage-aware placement resolver ──────
// The ordered rule (walk-up containing root → owning storage's dedicated repo → first-time signal →
// last-resort .lfbridge/) lives in storage/artifact-placement.service.ts so transcription and AI
// description never drift. Here we apply the `.lfbridge/<rel-dir>/<name.ext>.transcription` shape (§3.1)
// onto whatever root it returns.

/** The placement root the transcript is mirrored under for a media file (§3.4). Kept for callers that only
 *  need the root; the full placement (incl. needsSetup) comes from resolveTranscriptPath. */
export function resolveStorageRoot(absFile: string): string {
  return resolveArtifactPlacement(absFile).root;
}

/** <root>/.lfbridge/<rel-dir>/<name.ext>.transcription — the transcript inside the committed `.lfbridge/`
 *  tracking dir (§3.1), plus the first-time setup gate (§3.4–§3.5). The transcript is COMMITTED (travels
 *  with the repo), so there is no `*.transcription` gitignore nudge anymore. */
export function resolveTranscriptPath(absFile: string): {
  root: string;
  rel: string;
  transcriptPath: string;
  needsSetup: boolean;
} {
  const p = resolveArtifactPlacement(absFile);
  // Honor the repo's transcription placement radio (repo_settings.mdx §4): "lfbridge" (default) = the root's
  // TRACKING BASE, beside the media, or the state-sync repo. Falls back to the tracking base for an
  // unregistered root or an unconfigured sync repo. `p.owner` carries the already-resolved storage role, so
  // an SDL gets NO `.lfbridge/` segment even when its path doesn't follow the naming convention (§0).
  const placement = repoArtifactPlacement(p.root, "transcription");
  const transcriptPath = artifactPathForPlacement(p.root, p.rel, TRANSCRIPTION_EXT, placement, p.owner);
  return { root: p.root, rel: p.rel, transcriptPath, needsSetup: p.needsSetup };
}

// ── public API ────────────────────────────────────────────────────────────────────
export function transcribeToolStatus(): TranscribeTools {
  return engine.toolStatus();
}

/** The existing transcript for a media file (text + path), or null if none has been produced yet. */
export function readTranscript(input: string): TranscriptView | null {
  const abs = path.resolve(expandHome(input.trim()));
  const { transcriptPath } = resolveTranscriptPath(abs);
  if (!exists(transcriptPath)) return null;
  try {
    return { mediaPath: abs, transcriptPath, text: fs.readFileSync(transcriptPath, "utf8") };
  } catch {
    return null;
  }
}

/**
 * Transcribe ONE media file into its `.transcription` sidecar beside the media (§1). ASYNC and non-blocking —
 * the underlying engine spawns ffmpeg/whisper without freezing the event loop (§5.1). The actual run is
 * wrapped in a progress-registry job (kind "transcribe") so the web app's progress dock shows a live,
 * determinate card — even for a run this browser tab did not start (webapp.mdx §12/§14).
 */
export async function transcribeOne(input: string, overwrite = false): Promise<TranscribeResult> {
  const abs = path.resolve(expandHome(input.trim()));
  const name = path.basename(abs);

  if (!exists(abs)) return result(abs, "failed", null, null, "file not found");
  if (!mediaKindForName(name) || !engineCanTranscribe(name)) {
    return result(abs, "skipped", null, null, "not an audio/video file");
  }

  const { root, transcriptPath, needsSetup } = resolveTranscriptPath(abs);
  // First-time gate (§3.5): no Personal storage exists and nothing owns this file — don't write somewhere
  // surprising; tell the UI to run the setup wizard. Never produces a file.
  if (needsSetup) {
    return result(abs, "needs_setup", null, null, "no storage is set up for this file — configure Personal storage first");
  }
  if (!overwrite && exists(transcriptPath)) {
    return result(abs, "skipped", transcriptPath, null, "already transcribed");
  }
  // The transcript lands in the COMMITTED .lfbridge/ area (§3.1), so it travels with the repo and there is
  // no `*.transcription` gitignore nudge — the multi-GB media stays git-ignored and rides IPFS.

  // Pick the engine (qwen heavyweight → whisper fallback, transcribe_engine.mdx §2) from the app config,
  // with the qwen→mac auto-fallback (§2.1). The transcript header records whichever engine actually ran.
  const cfg = getAppConfig().transcribe;

  // The work ledger (transactions_log.mdx §5.5). Until now this runner logged ONLY terminal outcomes — a
  // log.info on success, a WARN/ERROR on failure — and never a START, which is the same silent-failure gap
  // that made the 2026-07-15 describe incident un-debuggable: a file whose engine takes the process down
  // leaves NO trace it ever began, so an overnight batch that stops halfway is indistinguishable from one
  // that finished. The BEGIN below lands BEFORE the engine runs, and the END fires in txn()'s `finally`, so
  // an un-ENDed BEGIN followed by a BOOT means exactly one thing: we died transcribing THIS file.
  //
  // The ledger is purely ADDITIVE — every log.* call and every return shape below is unchanged, and a
  // ledger write can never throw (transactions_log.mdx §8). It is a second, durable record, not a rewrite
  // of the first.
  return txn(
    "transcribe",
    { file: abs, bytes: sizeOf(abs), engine: cfg.engine, overwrite },
    async (t, end): Promise<TranscribeResult> => {
      const r = await track("transcribe", name, (report) =>
        transcribeWithEngine(abs, transcriptPath, {
          engine: cfg.engine,
          consent: cfg.model_consent,
          // The engine run is this transcribe's CHILD (§4) — `grep <txn>` then returns the file's whole
          // story, engine choice and any fallback included, de-interleaved from its concurrent siblings.
          parent: t.id,
          onProgress: ({ fraction }) => report({ done: Math.round(fraction * 100), total: 100, unit: "%" }),
        }),
      );
      const status: TranscribeResult["status"] =
        r.status === "transcribed" ? "transcribed" : r.status === "no_audio" ? "no_audio" : r.status === "tool_missing" ? "tool_missing" : "failed";
      // `engineUsed` — NOT the configured preference — is what belongs in the ledger: the fallback chain can
      // silently degrade qwen → mac, and a batch that ran 900 of 1,000 files on the fallback engine is a
      // quality incident that is otherwise invisible (§5.5).
      end({ engine: r.engineUsed, words: r.words ?? 0 });
      if (status === "transcribed") {
        // Cross the content threshold (artifact_placement_policy.mdx §2): this repo has now produced a durable
        // user artifact, so its `.lfbridge/` tracking placement is justified from here on (a one-way latch).
        markDurableArtifact(root);
        // THE WRITE IS THE TRIGGER (storage_personal.mdx §18.5.3.1 / AC-29) — producing a durable artifact
        // schedules its own sync, so a transcript never again depends on the device worker's `git add -A`.
        noteArtifactWritten(transcriptPath, "transcripts");
        log.info("transcribe", `${abs} → ${transcriptPath} (${r.words ?? 0} words, ${r.engineUsed})`);
      } else if (status === "tool_missing" || status === "failed") {
        // Report truthfully to the durable fault trail (Transcribe.mdx §1 "report truthfully" + charter logging):
        // a non-success is a WARN/ERROR that must reach error.err, not a silent skip. tool_missing is a
        // recoverable setup gap (WARN); a genuine failure is an ERROR.
        const line = `${abs}: ${status} — ${r.reason ?? "no reason given"} (engine ${r.engineUsed})`;
        if (status === "tool_missing") log.warn("transcribe", `not transcribed: ${line}`);
        else log.error("transcribe", `transcription failed: ${line}`);
        // A non-throwing failure is still a failure. txn() defaults an END to outcome=ok, so a status the
        // engine REPORTED (rather than threw) must say so explicitly or the ledger would read it as a
        // success. Both land as outcome=failed — matching summarize() below, which also counts tool_missing
        // as failed — and `reason` is what tells the two apart when you grep the failures.
        end({ outcome: "failed", reason: status === "tool_missing" ? "tool_missing" : "engine_failed" });
      } else if (status === "no_audio") {
        end({ outcome: "skipped", reason: "no_audio" });
      }
      return result(abs, status, r.outputPath, r.words, r.reason);
    },
  );
}

/** Transcribe a selected set of files (§2.3). Never throws — each file reports its own outcome. */
export async function transcribeMany(inputs: string[], overwrite = false): Promise<TranscribeBatchResult> {
  const results: TranscribeResult[] = [];
  for (const p of inputs) {
    try {
      results.push(await transcribeOne(p, overwrite));
    } catch (e) {
      // An unexpected throw from transcribeOne (placement/config/engine crash) must hit the durable fault
      // trail — otherwise a whole batch can "fail" with nothing in error.err (the reported symptom).
      log.error("transcribe", `transcribeOne threw for ${p}: ${(e as Error).stack ?? (e as Error).message}`);
      results.push(result(p, "failed", null, null, (e as Error).message));
    }
  }
  return summarize(results);
}

/** Transcribe ALL audio/video under a directory or repo working tree (§2.4). */
export async function transcribeTree(input: string, overwrite = false): Promise<TranscribeBatchResult> {
  const abs = path.resolve(expandHome(input.trim()));
  if (!exists(abs)) return summarize([result(abs, "failed", null, null, "path not found")]);
  const media = walkMedia(abs);
  log.info("transcribe", `tree transcribe: ${media.length} media file(s) under ${abs}`);
  return transcribeMany(media, overwrite);
}

/** Transcribe ALL audio/video in a storage, resolved by its Storages-row id (§2.4). */
export async function transcribeStorageById(id: string, overwrite = false): Promise<TranscribeBatchResult> {
  const detail = getStorageDetail(id); // throws for unknown id (router maps to 404)
  if (detail.storage.type === "local") {
    return summarize([result(detail.storage.root, "skipped", null, null, "local storage holds no media")]);
  }
  return transcribeTree(detail.storage.root, overwrite);
}

/**
 * The "Create Transcriptions" PAGE ACTION (page_actions.mdx §5) — plan + background-queue. Resolves the
 * set (checked `paths`, else the recursive `root`), drops files that already have a transcript and
 * non-audio/-video files (skip-already-done, page_actions.mdx §1.2), hands the eligible remainder to the
 * background queue ([job_queue.mdx](../jobqueue)), and returns the PLAN immediately — never the results.
 * The caller returns without awaiting the queue; each file surfaces its own `transcribe` dock card as it runs.
 */
export function enqueueTranscribe(opts: { paths?: string[]; root?: string; overwrite?: boolean }): EnqueuePlan {
  const overwrite = opts.overwrite ?? false;
  const candidates = resolveCandidates(opts);
  let alreadyDone = 0;
  let unsupported = 0;
  let needSetup = 0;
  const eligible: string[] = [];
  for (const abs of candidates) {
    const name = path.basename(abs);
    if (!mediaKindForName(name) || !engine.canTranscribe(name)) {
      unsupported++;
      continue;
    }
    // Resolving the placement must not be fatal to the whole enqueue (mirror of previewTranscribe). On a
    // resolve failure, still queue the file — the per-file transcribe job records its own failure — rather
    // than 400-ing Confirm and dropping the entire batch.
    let needsSetupForThis = false;
    try {
      const tp = resolveTranscriptPath(abs);
      // A file that needs first-time setup has no real destination yet — never counts as already-done.
      if (!overwrite && !tp.needsSetup && exists(tp.transcriptPath)) {
        alreadyDone++;
        continue;
      }
      needsSetupForThis = tp.needsSetup;
    } catch (e) {
      log.warn("transcribe", `enqueue: could not resolve transcript state for ${abs}: ${(e as Error).message}`);
    }
    eligible.push(abs);
    if (needsSetupForThis) needSetup++;
  }
  // First-time gate (Transcribe.mdx §3.5): if EVERY eligible file needs setup (no Personal storage owns
  // them), queue nothing and tell the UI to open the wizard with a representative path.
  if (eligible.length > 0 && needSetup === eligible.length) {
    log.info("transcribe", `enqueue: ${eligible.length} eligible all need first-time setup — not queuing`);
    return { considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported, queued: 0, willProcess: 0, needsSetup: true, setupPath: eligible[0], blocked: false, blockedReason: null };
  }
  // The BATCH MANIFEST, before the enqueue (to_fix.mdx §4.1, invariant §10.4). Transcribe has no
  // provider to preflight, but a lost transcribe batch is exactly as unreconstructable as a lost
  // describe one — the manifest requirement is about the CLICK, not about the provider.
  const manifest = writeManifest({
    op: "transcribe",
    scope: scopeLabel(opts),
    counts: { considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported },
    files: eligible.map((p) => ({ path: p, sizeBytes: safeSize(p) })),
  });
  const { queued } = enqueue(eligible.map((p) => ({ op: "transcribe", path: p, overwrite, batchId: manifest.batchId })));
  // Seed with what actually queued, not what was eligible (see the note in describe's enqueue).
  trackBatch(manifest.batchId, queued);
  log.info("transcribe", `enqueue [${scopeLabel(opts)}]: ${candidates.length} considered → ${queued} queued (${alreadyDone} already done, ${unsupported} unsupported)`);
  // `blocked` is always false here: transcription runs LOCALLY (Whisper/qwen), so there is no provider
  // account to preflight and no circuit that can refuse it (to_fix.mdx §2.5 — the gate is describe-only).
  return { considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported, queued, willProcess: queued, needsSetup: false, setupPath: null, blocked: false, blockedReason: null };
}

/**
 * PREVIEW the eligible transcription candidates for a scope WITHOUT queuing anything (dialogs.mdx §5.2).
 * Same Rule-1 (scope) + Rule-2 (skip-already-done, drop unsupported) narrowing as `enqueueTranscribe`, but
 * it returns the eligible candidate FILE LIST (path + size) so the unified batch-confirm popup can list them
 * checked-by-default. First-time-setup files stay in the list (their wizard fires later, at the popup's
 * Apply → enqueue). Nothing is ever written or queued here.
 */
export function previewTranscribe(opts: { paths?: string[]; root?: string; overwrite?: boolean }): PreviewPlan {
  const overwrite = opts.overwrite ?? false;
  const candidates = resolveCandidates(opts);
  let alreadyDone = 0;
  let unsupported = 0;
  const files: PreviewPlan["files"] = [];
  for (const abs of candidates) {
    const name = path.basename(abs);
    if (!mediaKindForName(name) || !engine.canTranscribe(name)) {
      unsupported++;
      continue;
    }
    // Resolving the transcript placement (or checking an existing transcript) must NEVER be fatal to the
    // whole preview — a single un-resolvable candidate would otherwise 400 /transcribe/plan and the batch
    // popup would never open (dialogs.mdx §6.4). Treat a resolve/read failure as "not yet transcribed" so
    // the file is still OFFERED rather than dropping the whole scan.
    try {
      const tp = resolveTranscriptPath(abs);
      if (!overwrite && !tp.needsSetup && exists(tp.transcriptPath)) {
        alreadyDone++;
        continue;
      }
    } catch (e) {
      log.warn("transcribe", `preview: could not resolve transcript state for ${abs}: ${(e as Error).message}`);
    }
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(abs).size;
    } catch {
      /* size unknown — leave 0 */
    }
    files.push({ path: abs, sizeBytes });
  }
  log.info("transcribe", `preview [${scopeLabel(opts)}]: ${candidates.length} considered → ${files.length} candidates (${alreadyDone} already done, ${unsupported} unsupported)`);
  return { files, considered: candidates.length, alreadyDone, unsupported };
}

/**
 * The candidate set for a page action (page_actions.mdx §1.1): a non-empty `paths` is the CHECKED set
 * (used as-is); otherwise `root` is walked recursively for media. Exactly one must be supplied.
 */
function resolveCandidates(opts: { paths?: string[]; root?: string }): string[] {
  if (opts.paths && opts.paths.length > 0) {
    return opts.paths.map((p) => path.resolve(expandHome(p.trim())));
  }
  if (opts.root && opts.root.trim()) {
    return walkMedia(path.resolve(expandHome(opts.root.trim())));
  }
  throw new Error("enqueue requires either paths[] (the checked set) or root (to walk recursively)");
}

// ── walk + helpers ──────────────────────────────────────────────────────────────
/** The scope a page action asked for, for the enqueue log line — the walked root, or the checked-set size.
 *  Answers "which page queued these jobs?" when the queue is read back later. */
function scopeLabel(opts: { paths?: string[]; root?: string }): string {
  if (opts.paths && opts.paths.length > 0) return `${opts.paths.length} checked path(s)`;
  return opts.root ? `root ${path.resolve(expandHome(opts.root.trim()))}` : "no scope";
}

/** Recursively collect audio/video file paths under `root`, skipping hidden/tracking/heavy dirs. */
function walkMedia(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
        visit(path.join(dir, ent.name));
      } else if (ent.isFile() && engine.canTranscribe(ent.name)) {
        out.push(path.join(dir, ent.name));
      }
    }
  };
  try {
    fs.statSync(root).isDirectory() ? visit(root) : engine.canTranscribe(root) && out.push(root);
  } catch {
    /* unreadable root */
  }
  return out;
}

function result(
  p: string,
  status: TranscribeResult["status"],
  transcriptPath: string | null,
  words: number | null,
  reason: string | null,
): TranscribeResult {
  return { path: p, status, transcriptPath, words, reason };
}

function summarize(results: TranscribeResult[]): TranscribeBatchResult {
  return {
    results,
    transcribed: results.filter((r) => r.status === "transcribed").length,
    // needs_setup is counted with skipped (nothing produced, not an error) so the counts still sum.
    skipped: results.filter((r) => r.status === "skipped" || r.status === "no_audio" || r.status === "needs_setup").length,
    failed: results.filter((r) => r.status === "failed" || r.status === "tool_missing").length,
  };
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** A file's size for the batch manifest, or undefined if it can't be read (to_fix.mdx §4.1). */
function safeSize(p: string): number | undefined {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
}

/** Input size for the ledger's `bytes` field (transactions_log.mdx §3.3) — the single best predictor of both
 *  duration and heap. Never throws: an unstattable file must not fail a transcription. */
function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}
