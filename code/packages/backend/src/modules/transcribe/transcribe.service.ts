// Transcription service (Transcribe.mdx). Wraps the in-process Transcribe engine (tools/transcribe) with
// LFBridge's storage-aware placement: a transcript is written to a PARALLEL hidden hierarchy under the
// OWNING STORAGE ROOT — <storageRoot>/.transcribe/<relpath>.txt (§3), recreating the media file's
// relative directory path and keeping its name. Also drives the "Transcribe all files" walks over a
// directory / repo / storage. Explicit-user-action only (§7); reports truthfully per file (§6).
import fs from "node:fs";
import path from "node:path";
import type { TranscribeResult, TranscribeBatchResult, TranscribeTools, TranscriptView, EnqueuePlan } from "@lfb/shared";
import { mediaKindForName } from "@lfb/shared";
import { Transcriber } from "../../tools/transcribe/Transcribe.js";
import { expandHome } from "../fs/badges.js";
import { resolveArtifactPlacement } from "../storage/artifact-placement.service.js";
import { getStorageDetail } from "../storage/storage.service.js";
import { track } from "../progress/progress.registry.js";
import { enqueue } from "../jobqueue/jobqueue.service.js";
import { log } from "../../shared/logging.js";

// The parallel hidden hierarchy under a storage root (Transcribe.mdx §3). Single constant — rename here
// to change the dot-directory name everywhere. (The product owner referred to it loosely as ".flac/".)
export const TRANSCRIBE_DIR = ".transcribe";

// Directories a "Transcribe all" walk never descends into.
const SKIP_DIRS = new Set([TRANSCRIBE_DIR, ".lfbridge", ".git", "node_modules"]);

const engine = new Transcriber();

// ── transcript-path resolution (§3.4) — delegated to the shared, storage-aware placement resolver ──────
// The ordered rule (walk-up containing root → owning storage's dedicated repo → first-time signal →
// beside-media) lives in storage/artifact-placement.service.ts so transcription and AI description never
// drift. Here we just append the `.transcribe/<rel>.txt` shape onto whatever base it returns.

/** The base directory the `.transcribe/` tree hangs under for a media file (§3.4). Kept for callers that
 *  only need the root; the full placement (incl. gitIgnore / needsSetup) comes from resolveTranscriptPath. */
export function resolveStorageRoot(absFile: string): string {
  return resolveArtifactPlacement(absFile).root;
}

/** <base>/.transcribe/<rel>.txt — the transcript destination, plus the placement flags that drive the
 *  gitignore nudge (only in a plain repo, never a dedicated repo) and the first-time setup gate (§3.4–§3.5). */
export function resolveTranscriptPath(absFile: string): {
  root: string;
  rel: string;
  transcriptPath: string;
  gitIgnore: boolean;
  needsSetup: boolean;
} {
  const p = resolveArtifactPlacement(absFile);
  const transcriptPath = path.join(p.root, TRANSCRIBE_DIR, `${p.rel}.txt`);
  return { root: p.root, rel: p.rel, transcriptPath, gitIgnore: p.gitIgnore, needsSetup: p.needsSetup };
}

/** Keep the parallel hierarchy out of Git (added alongside the existing .lfbridge/ ignore). */
function ensureTranscribeIgnored(root: string): void {
  if (!exists(path.join(root, ".git"))) return;
  const gi = path.join(root, ".gitignore");
  let body = "";
  try {
    body = fs.readFileSync(gi, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  if (new RegExp(`^${TRANSCRIBE_DIR}\\/?\\s*$`, "m").test(body)) return;
  const prefix = body && !body.endsWith("\n") ? `${body}\n` : body;
  try {
    fs.writeFileSync(gi, `${prefix}${TRANSCRIBE_DIR}/\n`, "utf8");
  } catch (e) {
    log.warn("transcribe", `could not update .gitignore in ${root}: ${(e as Error).message}`);
  }
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
 * Transcribe ONE media file into the parallel `.transcribe/` hierarchy (§1). ASYNC and non-blocking —
 * the underlying engine spawns ffmpeg/whisper without freezing the event loop (§5.1). The actual run is
 * wrapped in a progress-registry job (kind "transcribe") so the web app's progress dock shows a live,
 * determinate card — even for a run this browser tab did not start (webapp.mdx §12/§14).
 */
export async function transcribeOne(input: string, overwrite = false): Promise<TranscribeResult> {
  const abs = path.resolve(expandHome(input.trim()));
  const name = path.basename(abs);

  if (!exists(abs)) return result(abs, "failed", null, null, "file not found");
  if (!mediaKindForName(name) || !engine.canTranscribe(name)) {
    return result(abs, "skipped", null, null, "not an audio/video file");
  }

  const { root, transcriptPath, gitIgnore, needsSetup } = resolveTranscriptPath(abs);
  // First-time gate (§3.5): no Personal storage exists and nothing owns this file — don't write somewhere
  // surprising; tell the UI to run the setup wizard. Never produces a file.
  if (needsSetup) {
    return result(abs, "needs_setup", null, null, "no storage is set up for this file — configure Personal storage first");
  }
  if (!overwrite && exists(transcriptPath)) {
    return result(abs, "skipped", transcriptPath, null, "already transcribed");
  }
  // Only keep the dot-dir out of Git for a PLAIN repo (rule A). A dedicated repo (rule B) exists to hold
  // and sync these artifacts, so we deliberately do NOT gitignore there (Transcribe.mdx §3.4).
  if (gitIgnore) ensureTranscribeIgnored(root);

  const r = await track("transcribe", name, (report) =>
    engine.transcribeToFile(abs, transcriptPath, ({ fraction }) =>
      report({ done: Math.round(fraction * 100), total: 100, unit: "%" }),
    ),
  );
  const status: TranscribeResult["status"] =
    r.status === "transcribed" ? "transcribed" : r.status === "no_audio" ? "no_audio" : r.status === "tool_missing" ? "tool_missing" : "failed";
  if (status === "transcribed") log.info("transcribe", `${abs} → ${transcriptPath} (${r.words ?? 0} words)`);
  return result(abs, status, r.outputPath, r.words, r.reason);
}

/** Transcribe a selected set of files (§2.3). Never throws — each file reports its own outcome. */
export async function transcribeMany(inputs: string[], overwrite = false): Promise<TranscribeBatchResult> {
  const results: TranscribeResult[] = [];
  for (const p of inputs) {
    try {
      results.push(await transcribeOne(p, overwrite));
    } catch (e) {
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
  const eligible: string[] = [];
  for (const abs of candidates) {
    const name = path.basename(abs);
    if (!mediaKindForName(name) || !engine.canTranscribe(name)) {
      unsupported++;
      continue;
    }
    if (!overwrite && exists(resolveTranscriptPath(abs).transcriptPath)) {
      alreadyDone++;
      continue;
    }
    eligible.push(abs);
  }
  const { queued } = enqueue(eligible.map((p) => ({ op: "transcribe", path: p, overwrite })));
  log.info("transcribe", `enqueue: ${candidates.length} considered → ${queued} queued (${alreadyDone} already done, ${unsupported} unsupported)`);
  return { considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported, queued, willProcess: queued };
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
