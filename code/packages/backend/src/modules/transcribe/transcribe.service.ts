// Transcription service (Transcribe.mdx). Wraps the in-process Transcribe engine (tools/transcribe) with
// LFBridge's storage-aware placement: a transcript is written to a PARALLEL hidden hierarchy under the
// OWNING STORAGE ROOT — <storageRoot>/.transcribe/<relpath>.txt (§3), recreating the media file's
// relative directory path and keeping its name. Also drives the "Transcribe all files" walks over a
// directory / repo / storage. Explicit-user-action only (§7); reports truthfully per file (§6).
import fs from "node:fs";
import path from "node:path";
import type { TranscribeResult, TranscribeBatchResult, TranscribeTools, TranscriptView } from "@lfb/shared";
import { mediaKindForName } from "@lfb/shared";
import { Transcriber } from "../../tools/transcribe/Transcribe.js";
import { expandHome } from "../fs/badges.js";
import { getStorageDetail } from "../storage/storage.service.js";
import { track } from "../progress/progress.registry.js";
import { log } from "../../shared/logging.js";

// The parallel hidden hierarchy under a storage root (Transcribe.mdx §3). Single constant — rename here
// to change the dot-directory name everywhere. (The product owner referred to it loosely as ".flac/".)
export const TRANSCRIBE_DIR = ".transcribe";

// Directories a "Transcribe all" walk never descends into.
const SKIP_DIRS = new Set([TRANSCRIBE_DIR, ".lfbridge", ".git", "node_modules"]);

const engine = new Transcriber();

// ── storage-root + transcript-path resolution (§3.4) ──────────────────────────────
/** True when `dir` is a storage root: it carries storage.yaml, a .lfbridge/, or a .git/ (a repo). */
function isStorageRoot(dir: string): boolean {
  return (
    exists(path.join(dir, "storage.yaml")) ||
    exists(path.join(dir, ".lfbridge")) ||
    exists(path.join(dir, ".git"))
  );
}

/**
 * The nearest ancestor of `absFile` that is a storage root (§3.4). When none is found, the file's own
 * directory is used as the base, so a stray file still gets a `.transcribe/` beside it.
 */
export function resolveStorageRoot(absFile: string): string {
  let dir = path.dirname(absFile);
  const stopAt = path.parse(dir).root;
  while (dir && dir !== stopAt) {
    if (isStorageRoot(dir)) return dir;
    dir = path.dirname(dir);
  }
  if (dir === stopAt && isStorageRoot(dir)) return dir;
  return path.dirname(absFile);
}

/** <storageRoot>/.transcribe/<relpath>.txt — mirrors the media file's relative path, keeps its name. */
export function resolveTranscriptPath(absFile: string): { root: string; rel: string; transcriptPath: string } {
  const root = resolveStorageRoot(absFile);
  const rel = path.relative(root, absFile);
  const transcriptPath = path.join(root, TRANSCRIBE_DIR, `${rel}.txt`);
  return { root, rel, transcriptPath };
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

  const { root, transcriptPath } = resolveTranscriptPath(abs);
  if (!overwrite && exists(transcriptPath)) {
    return result(abs, "skipped", transcriptPath, null, "already transcribed");
  }
  ensureTranscribeIgnored(root);

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
    skipped: results.filter((r) => r.status === "skipped" || r.status === "no_audio").length,
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
