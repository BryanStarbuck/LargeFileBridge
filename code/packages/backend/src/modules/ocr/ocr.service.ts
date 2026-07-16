// OCR service (ocr.mdx). Reads the text VISIBLE IN THE PIXELS of a local image/video and stores it as a
// `<name.ext>.ocr` artifact inside the owning root's committed tracking area, path-mirrored, extension
// APPENDED — identical placement to `.transcription` / `.ai_description` (§5).
//
// The two-speed rule (§2, LOCKED) lives here: an IMAGE gets ONE accurate pass; a VIDEO is SAMPLED every 15s
// and each frame gets a FAST pass. That is not a tuning preference — a 40-minute clip is 160 frames, and the
// accurate level would make the feature unusable at tree scale (§15 vs §16).
//
// UNLIKE describe, this is 100% LOCAL (§4): no provider, no API key, no upload, no credentials popup, and no
// transient/permanent retry problem — there is no network to be flaky. Its only ceiling is the box.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { OcrBlock, OcrKind, OcrResult, OcrBatchResult, OcrView, OcrEngineId, OcrEnginesStatus, EnqueuePlan, PreviewPlan } from "@lfb/shared";
import { mediaKindForName } from "@lfb/shared";
import { HARD_SKIP } from "../../shared/scan-filters.js";
import { expandHome } from "../fs/badges.js";
import { getAppConfig } from "../store-model/config.service.js";
import { resolveArtifactPlacement, artifactPathForPlacement, OCR_EXT } from "../storage/artifact-placement.service.js";
import { markDurableArtifact } from "../storage/tracking-root.service.js";
import { noteArtifactWritten } from "../pin/sync-trigger.service.js";
import { repoArtifactPlacement } from "../store-model/units.service.js";
import { track } from "../progress/progress.registry.js";
import { enqueue, createBatch } from "../jobqueue/jobqueue.service.js";
import { writeManifest, trackBatch } from "../jobqueue/batch-manifest.service.js";
import { selectEngine, engineStatus, ocrLanguage } from "./engines.js";
import { extractFrames, videoToolsPresent, probeVideo, frameCountFor, collapseDuplicates } from "./frames.js";
import { coreBudget } from "../../shared/concurrency.js";
import { log } from "../../shared/logging.js";
import { txn, txnBegin, txnEnd, type TxnOutcome, type TxnFields } from "../../shared/transactions.js";

/** Directories an "OCR all" walk never descends into — the same hard-skip set the discovery scan and the
 *  describe/transcribe walks use (scan.mdx §4 invariant), plus the artifact dirs. */
const SKIP_DIRS = new Set([...HARD_SKIP, ".lfbridge", ".transcribe"]);

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Only image + video have pixels to read (§1.7). Audio is transcription's job. */
function ocrKindFor(name: string): OcrKind | null {
  const k = mediaKindForName(name);
  return k === "image" || k === "video" ? k : null;
}

/** `<trackingBase(root)>/<rel-dir>/<name.ext>.ocr` — resolved by the SHARED ordered placement rule and the
 *  repo's placement radio, exactly like a transcript/description (§5, §5.3). The kind-keyed base means a
 *  working repo gets `.lfbridge/` and an SDL gets none — via trackingBaseDir(), never a hard-coded join. */
export function resolveOcrPath(absFile: string): { root: string; rel: string; ocrPath: string; needsSetup: boolean } {
  const p = resolveArtifactPlacement(absFile);
  // OCR reuses the SAME radio transcription/description obey — a repo's ONE placement choice governs all
  // three artifacts (§5.3). There is deliberately no separate "where does OCR text go" control.
  const placement = repoArtifactPlacement(p.root, "ocr");
  const ocrPath = artifactPathForPlacement(p.root, p.rel, OCR_EXT, placement, p.owner);
  return { root: p.root, rel: p.rel, ocrPath, needsSetup: p.needsSetup };
}

/**
 * The existing OCR text for a media file, or null when there is no `done` artifact.
 *
 * THE EMPTY-TEXT RULE (§2.3, LOCKED). `text` may legitimately be "" — most images have no text. The artifact
 * EXISTING with `status: done` is the truth; the text being empty is a RESULT. Returning null for an empty
 * read would re-offer every text-free file in the tree forever (the popup would say "2,000 files can be
 * OCR'd" the morning after OCR'ing 2,000 files), which is the defect class ai_description.mdx §12.5 locks
 * closed for descriptions. So: null ⇔ absent or not-done. NEVER because `text` is "".
 */
export function readOcr(input: string): OcrView | null {
  const abs = path.resolve(expandHome(input.trim()));
  const { ocrPath } = resolveOcrPath(abs);
  if (!exists(ocrPath)) return null;
  try {
    const doc = (YAML.parse(fs.readFileSync(ocrPath, "utf8")) ?? {}) as Record<string, unknown>;
    if (doc.status !== "done") return null;
    // `?? ""` — not a fallback for a missing field but the deliberate empty-is-valid path (§2.3).
    return {
      mediaPath: abs,
      ocrPath,
      text: typeof doc.text === "string" ? doc.text : "",
      blocks: Array.isArray(doc.blocks) ? (doc.blocks as OcrBlock[]) : [],
      engine: (doc.engine as OcrEngineId) ?? null,
      level: (doc.level as OcrView["level"]) ?? null,
      kind: (doc.kind as OcrKind) ?? null,
      generatedAt: (doc.generated as string) ?? null,
      strideSeconds: typeof doc.stride_seconds === "number" ? doc.stride_seconds : null,
      framesSampled: typeof doc.frames_sampled === "number" ? doc.frames_sampled : null,
      truncated: doc.truncated === true,
    };
  } catch {
    return null;
  }
}

function result(p: string, status: OcrResult["status"], ocrPath: string | null, engine: OcrEngineId | null, chars: number | null, reason: string | null): OcrResult {
  return { path: p, status, ocrPath, engine, chars, reason };
}

function sizeOf(abs: string): number {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

/** An OCR that produces NOTHING still gets a ledger pair (transactions_log.mdx §5.2's rule, applied to the
 *  third op): "it did nothing" and "it never started" must never look the same on disk. */
function ledgerNoWork(abs: string, fields: TxnFields, outcome: TxnOutcome, reason: string): void {
  const t = txnBegin("ocr", { file: abs, ...fields });
  txnEnd(t, outcome, { reason });
}

/** The engine matrix + the video path's tool dependency, for Settings → Tools and the readiness gate (§6). */
export function ocrEngines(): OcrEnginesStatus {
  const engines = engineStatus();
  const cfg = getAppConfig().ocr;
  return {
    engines,
    defaultEngine: cfg?.engine ?? "auto",
    anyAvailable: engines.some((e) => e.available),
    // Stated separately BECAUSE the asymmetry is real (§6): an ffmpeg-less machine OCRs every image fine and
    // every video not at all. Papering over it would make "OCR is broken" the user's conclusion.
    videoToolsPresent: videoToolsPresent(),
    language: ocrLanguage(),
    strideSeconds: cfg?.video_stride_seconds ?? 15,
  };
}

/**
 * Run (or re-run) OCR on ONE media file. Never throws for the expected outcomes — those come back as a status
 * the UI reports truthfully.
 */
export async function ocrOne(input: string, opts: { overwrite?: boolean; engine?: OcrEngineId | "auto" } = {}): Promise<OcrResult> {
  const abs = path.resolve(expandHome(input.trim()));
  const name = path.basename(abs);
  if (!exists(abs)) {
    ledgerNoWork(abs, {}, "failed", "file_not_found");
    return result(abs, "failed", null, null, null, "file not found");
  }
  const bytes = sizeOf(abs);

  const kind = ocrKindFor(name);
  if (!kind) {
    ledgerNoWork(abs, { bytes }, "blocked", "unsupported_kind");
    return result(abs, "unsupported", null, null, null, "only images and videos have text to read");
  }

  const { root, ocrPath, needsSetup } = resolveOcrPath(abs);
  if (needsSetup) {
    ledgerNoWork(abs, { bytes, kind }, "blocked", "needs_setup");
    return result(abs, "needs_setup", null, null, null, "no storage is set up for this file — configure Personal storage first");
  }
  // Skip-already-done keys on the ARTIFACT, never on the text being non-empty (§12.4 / §2.3).
  if (!opts.overwrite && readOcr(abs)) {
    ledgerNoWork(abs, { bytes, kind }, "skipped", "already_ocred");
    return result(abs, "skipped", ocrPath, null, null, "already has OCR text");
  }

  const engine = selectEngine(opts.engine);
  if (!engine) {
    const reason = "no OCR engine is available on this computer";
    ledgerNoWork(abs, { bytes, kind }, "blocked", "no_engine");
    log.error("ocr", `ocr skipped for ${abs}: ${reason}`);
    return result(abs, "no_engine", null, null, null, reason);
  }
  // The VIDEO path needs ffmpeg to sample frames; the IMAGE path needs no external tool at all (§6).
  if (kind === "video" && !videoToolsPresent()) {
    const reason = "reading text from a video needs ffmpeg — install it with `brew install ffmpeg` (images are unaffected)";
    ledgerNoWork(abs, { bytes, kind }, "blocked", "needs_ffmpeg");
    return result(abs, "needs_ffmpeg", null, null, null, reason);
  }

  const cfg = getAppConfig().ocr;
  const stride = cfg?.video_stride_seconds ?? 15;
  const maxFrames = cfg?.max_frames ?? 1000;
  const language = ocrLanguage();
  // The two-speed rule (§2, LOCKED): image → accurate, video frame → fast.
  const level = kind === "image" ? "accurate" : "fast";

  try {
    return await txn("ocr", { file: abs, bytes, engine: engine.id, kind, level, overwrite: !!opts.overwrite }, async (_t, end) => {
      const doc = await track("ocr", name, async () =>
        kind === "image"
          ? await ocrImage(abs, engine, language)
          : await ocrVideo(abs, engine, language, stride, maxFrames),
      );

      fs.mkdirSync(path.dirname(ocrPath), { recursive: true });
      fs.writeFileSync(
        ocrPath,
        YAML.stringify({
          source: path.relative(root, abs),
          status: "done",
          engine: engine.id,
          level,
          generated: new Date().toISOString(),
          kind,
          language,
          ...(kind === "video" ? { stride_seconds: stride, frames_sampled: doc.framesSampled, truncated: doc.truncated } : {}),
          text: doc.text,
          blocks: doc.blocks,
        }),
        "utf8",
      );
      // An OCR artifact ALONE is a durable user artifact, so this repo's tracking placement is justified from
      // here on (artifact_placement_policy.mdx §2 — the same one-way latch a transcript/description trips).
      markDurableArtifact(root);
      // THE WRITE IS THE TRIGGER (storage_personal.mdx §18.5.3.1 / AC-29) — producing a durable artifact
      // schedules its own sync, so OCR text never again depends on the device worker's `git add -A`.
      noteArtifactWritten(ocrPath, "OCR texts");
      // `chars`, never the text itself — recognized text never enters a ledger line (transactions_log §9).
      end({ chars: doc.text.length, blocks: doc.blocks.length, ...(kind === "video" ? { frames: doc.framesSampled } : {}) });
      log.info("ocr", `${abs} → ${ocrPath} (${engine.id}/${level}, ${doc.text.length} chars${kind === "video" ? `, ${doc.framesSampled} frames` : ""})`);
      return result(abs, "ocred", ocrPath, engine.id, doc.text.length, null);
    });
  } catch (e) {
    const msg = (e as Error).message;
    log.error("ocr", `ocr failed for ${abs} [engine=${engine.id}, kind=${kind}]: ${msg}`);
    return result(abs, "failed", null, engine.id, null, msg);
  }
}

interface OcrDoc {
  text: string;
  blocks: OcrBlock[];
  framesSampled: number | null;
  truncated: boolean;
}

/** The IMAGE path (§16): read, recognize accurately, done. No ffmpeg, no frames, no temp files, no gate — the
 *  simplest path in the app, and the highest-volume one. Deliberately NOT pre-scaled (§16.2 rule 4): full
 *  resolution is exactly what makes small text legible, and this is a one-shot cost. */
async function ocrImage(abs: string, engine: ReturnType<typeof selectEngine> & object, language: string): Promise<OcrDoc> {
  const r = await engine.recognize(abs, { level: "accurate", language });
  return { text: r.text, blocks: r.blocks, framesSampled: null, truncated: false };
}

/**
 * The VIDEO path (§2.2, §15): sample a frame every `stride` seconds, fast-OCR each, timecode it, collapse
 * consecutive duplicates, delete the temp frames.
 *
 * The recognitions run concurrently but draw the ONE SHARED recognition limiter (§10.2) — never a fresh
 * per-video budget. See `withRecognitionSlot` for why that distinction is the whole rule.
 */
async function ocrVideo(
  abs: string,
  engine: ReturnType<typeof selectEngine> & object,
  language: string,
  stride: number,
  maxFrames: number,
): Promise<OcrDoc> {
  const sample = await extractFrames(abs, { stride, maxFrames });
  try {
    const entries: Array<{ at: number; text: string; confidence: number | null }> = [];
    await Promise.all(
      sample.frames.map(async (f) => {
        const r = await withRecognitionSlot(() => engine.recognize(f.file, { level: "fast", language }));
        if (r.text.trim() === "") return; // a frame with no text contributes no entry
        const confidence = r.blocks.length ? avg(r.blocks.map((b) => b.confidence ?? 0)) : null;
        entries.push({ at: f.at, text: r.text, confidence });
      }),
    );
    entries.sort((a, b) => a.at - b.at);
    // Consecutive-duplicate collapse (§2.2.3): a slide on screen 3 minutes is ONE time-ranged entry, not 12.
    const timed = collapseDuplicates(entries, stride);
    const blocks: OcrBlock[] = timed.map((t) => ({ text: t.text, confidence: t.confidence, start: t.start, end: t.end }));
    // The flattened text is what search greps (§5.1). An entirely text-free video flattens to "" — which is a
    // SUCCESS with `frames_sampled: N`, not a failure (§2.3).
    const text = timed.map((t) => t.text).join("\n\n").trim();
    return { text, blocks, framesSampled: sample.frames.length, truncated: sample.truncated };
  } finally {
    // 160 JPEGs × 2,000 videos is real disk (§15.2 rule 8).
    await sample.cleanup();
  }
}

function avg(ns: number[]): number | null {
  if (ns.length === 0) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

// ── The ONE shared recognition limiter (ocr.mdx §10.2, LOCKED) ────────────────────────────────────────
//
// A VIDEO IS ITSELF A BATCH, and that is what makes this subtle. The queue already caps how many FILES run at
// once (`ocr:video` = floor(budget / VIDEO_THREADS)). If each of those files then fanned its frames out
// across the FULL core budget, the real concurrency would be the PRODUCT, not the budget:
//
//   5 concurrent videos × 22 frames each = 110 recognitions on a 22-core box.
//
// That is precisely the `cores²` over-subscription parallelization.mdx §2 calls the load-bearing invariant,
// and it is the mistake this module made before this limiter existed — a per-video `mapLimit(frames,
// coreBudget())` looks correct in isolation and is wrong in composition. A per-call budget cannot see the
// other calls; only shared state can.
//
// So both levels draw from ONE module-level semaphore, exactly as the pin pass does (pin_process.mdx §4, the
// shipped two-level/one-limiter reference). A single video being OCR'd alone fans its frames across the whole
// budget (fast); 20 videos at once SHARE that same budget between them (busy, never thrashing). The box is
// never oversubscribed and never idle.
//
// Images do not go through here on the frame path — one image is one recognition, and the queue's wide
// `ocr:image` cap is already exactly "one job per core".
let recognitionsActive = 0;
const recognitionWaiters: Array<() => void> = [];

async function withRecognitionSlot<T>(fn: () => Promise<T>): Promise<T> {
  const cap = coreBudget();
  while (recognitionsActive >= cap) {
    await new Promise<void>((resolve) => recognitionWaiters.push(resolve));
  }
  recognitionsActive++;
  try {
    return await fn();
  } finally {
    recognitionsActive--;
    recognitionWaiters.shift()?.();
  }
}

/** In-flight recognitions vs the budget — for tests and for reasoning about §10.2 at a glance. */
export function recognitionLoad(): { active: number; budget: number } {
  return { active: recognitionsActive, budget: coreBudget() };
}

/** OCR a selected SET of image/video files. Never throws — each file reports its own outcome. */
export async function ocrMany(inputs: string[], opts: { overwrite?: boolean; engine?: OcrEngineId | "auto" } = {}): Promise<OcrBatchResult> {
  const results: OcrResult[] = [];
  for (const p of inputs) {
    try {
      results.push(await ocrOne(p, opts));
    } catch (e) {
      results.push(result(path.resolve(expandHome(p.trim())), "failed", null, null, null, (e as Error).message));
    }
  }
  return summarizeOcr(results);
}

/** OCR ALL image/video under a directory or repo working tree. */
export async function ocrTree(input: string, opts: { overwrite?: boolean; engine?: OcrEngineId | "auto" } = {}): Promise<OcrBatchResult> {
  const abs = path.resolve(expandHome(input.trim()));
  if (!exists(abs)) return summarizeOcr([result(abs, "failed", null, null, null, "path not found")]);
  const media = walkOcrable(abs);
  log.info("ocr", `tree ocr: ${media.length} image/video file(s) under ${abs}`);
  return ocrMany(media, opts);
}

/**
 * The "Create OCR text" PAGE ACTION (page_actions.mdx §5 / ocr.mdx §8.5) — plan + background-queue. Resolves
 * the set (checked `paths`, else the recursive `root`), drops files that already have an artifact and
 * non-image/-video files, queues the eligible remainder, and returns the PLAN immediately.
 *
 * NOTE what is deliberately ABSENT versus describe's enqueue: there is NO provider preflight and NO circuit
 * breaker, because there is no account to be dead (§4). OCR cannot be blocked by anything but the box.
 */
export async function enqueueOcr(opts: { paths?: string[]; root?: string; overwrite?: boolean; engine?: OcrEngineId | "auto" }): Promise<EnqueuePlan> {
  const overwrite = opts.overwrite ?? false;
  const candidates = ocrCandidates(opts);
  let alreadyDone = 0;
  let unsupported = 0;
  let needSetup = 0;
  const eligible: string[] = [];
  for (const abs of candidates) {
    if (!ocrKindFor(path.basename(abs))) {
      unsupported++;
      continue;
    }
    // A resolve failure must never be fatal to the whole enqueue (the previewOcr twin): queue the file and let
    // its own job record the failure, rather than 400-ing Confirm and dropping the entire batch.
    let needsSetupForThis = false;
    try {
      const op = resolveOcrPath(abs);
      if (!overwrite && !op.needsSetup && readOcr(abs)) {
        alreadyDone++;
        continue;
      }
      needsSetupForThis = op.needsSetup;
    } catch (e) {
      log.warn("ocr", `enqueue: could not resolve OCR state for ${abs}: ${(e as Error).message}`);
    }
    eligible.push(abs);
    if (needsSetupForThis) needSetup++;
  }
  if (eligible.length > 0 && needSetup === eligible.length) {
    log.info("ocr", `enqueue: ${eligible.length} eligible all need first-time setup — not queuing`);
    return { considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported, queued: 0, willProcess: 0, needsSetup: true, setupPath: eligible[0], blocked: false, blockedReason: null };
  }

  const manifest = writeManifest({
    op: "ocr",
    scope: scopeLabel(opts),
    counts: { considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported },
    files: eligible.map((p) => ({ path: p, sizeBytes: safeSize(p) })),
  });
  const { queued } = enqueue(eligible.map((p) => ({ op: "ocr" as const, path: p, overwrite, batchId: manifest.batchId })));
  // Open the LIVE batch row (processing_batches.mdx §1) — ADOPTING the manifest's batchId, never minting a
  // second. Until this existed, only "Compress inside" ever created a row, so a 1,440-file OCR run showed
  // ZERO batches on the Processing page. `total` is what ACTUALLY queued (never `eligible`): enqueue dedups
  // against in-flight work and can refuse at the journal ceiling, and a denominator seeded too high would
  // never be reached, leaving the row stuck "running" forever. Called synchronously after enqueue — no
  // `await` in between, so no task can settle before the row exists.
  createBatch({
    batchId: manifest.batchId,
    kind: "ocr",
    label: `OCR · ${scopeLabel(opts)} · ${queued} files`,
    scope: scopeLabel(opts),
    total: queued,
    manifestPath: manifest.file,
  });
  trackBatch(manifest.batchId, queued);
  log.info("ocr", `enqueue [${scopeLabel(opts)}]: ${candidates.length} considered → ${queued} queued (${alreadyDone} already done, ${unsupported} unsupported)`);
  return { batchId: manifest.batchId, considered: candidates.length, eligible: eligible.length, alreadyDone, unsupported, queued, willProcess: queued, needsSetup: false, setupPath: null, blocked: false, blockedReason: null };
}

/**
 * PREVIEW the eligible OCR candidates for a scope WITHOUT queuing anything (dialogs.mdx §5.2). Same narrowing
 * as `enqueueOcr`, returning the candidate FILE LIST for the unified batch popup.
 *
 * Carries `frames` per VIDEO row — the one field OCR's plan has that its siblings' plans don't (§9.2). It is
 * what lets the popup show WHY one row is expensive before the user commits to it, which matters here more
 * than anywhere because an image is ~250ms and a 40-minute video is a frame-extraction pass plus 160
 * recognitions (§9.1). Async purely for the ffprobe duration reads.
 */
export async function previewOcr(opts: { paths?: string[]; root?: string; overwrite?: boolean }): Promise<PreviewPlan> {
  const overwrite = opts.overwrite ?? false;
  const candidates = ocrCandidates(opts);
  const cfg = getAppConfig().ocr;
  const stride = cfg?.video_stride_seconds ?? 15;
  const maxFrames = cfg?.max_frames ?? 1000;
  let alreadyDone = 0;
  let unsupported = 0;
  const files: PreviewPlan["files"] = [];
  const videos: string[] = [];
  for (const abs of candidates) {
    const kind = ocrKindFor(path.basename(abs));
    if (!kind) {
      unsupported++;
      continue;
    }
    try {
      const op = resolveOcrPath(abs);
      if (!overwrite && !op.needsSetup && readOcr(abs)) {
        alreadyDone++;
        continue;
      }
    } catch (e) {
      // Treat a resolve failure as "not yet OCR'd" so the file is still OFFERED rather than silently dropping
      // the whole scan — the bias that fixed describe's "right-click → does nothing" bug.
      log.warn("ocr", `preview: could not resolve OCR state for ${abs}: ${(e as Error).message}`);
    }
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(abs).size;
    } catch {
      /* size unknown — leave 0 */
    }
    files.push({ path: abs, sizeBytes });
    if (kind === "video") videos.push(abs);
  }
  // Frame counts for the video rows. Bounded + best-effort: ffprobe on a big checked set would otherwise be a
  // slow serial walk, and a per-row cost hint is a NICETY — never a reason for the popup not to open.
  if (videos.length > 0 && videos.length <= PREVIEW_PROBE_LIMIT && videoToolsPresent()) {
    await Promise.all(
      videos.map(async (v) => {
        try {
          const frames = frameCountFor(await probeVideo(v), stride, maxFrames);
          const row = files.find((f) => f.path === v);
          if (row && frames !== null) row.frames = frames;
        } catch {
          /* a row without a frame count still lists */
        }
      }),
    );
  }
  log.info("ocr", `preview [${scopeLabel(opts)}]: ${candidates.length} considered → ${files.length} candidates (${alreadyDone} already done, ${unsupported} unsupported)`);
  return { files, considered: candidates.length, alreadyDone, unsupported };
}

/** Beyond this many videos, skip the per-row frame-count probe: it is a cost HINT, and N ffprobes must not
 *  make the popup slow to open (dialogs.mdx §5.4's whole concern). */
const PREVIEW_PROBE_LIMIT = 200;

/** Checked `paths` used as-is, else the recursive `root` walked for image/video (page_actions.mdx §1.1). */
function ocrCandidates(opts: { paths?: string[]; root?: string }): string[] {
  if (opts.paths && opts.paths.length > 0) return opts.paths.map((p) => path.resolve(expandHome(p.trim())));
  if (opts.root && opts.root.trim()) return walkOcrable(path.resolve(expandHome(opts.root.trim())));
  throw new Error("enqueue requires either paths[] (the checked set) or root (to walk recursively)");
}

function scopeLabel(opts: { paths?: string[]; root?: string }): string {
  if (opts.paths && opts.paths.length > 0) return `${opts.paths.length} checked path(s)`;
  return opts.root ? `root ${path.resolve(expandHome(opts.root.trim()))}` : "no scope";
}

function safeSize(p: string): number | undefined {
  try {
    return fs.statSync(p).size;
  } catch {
    return undefined;
  }
}

/** Recursively collect image/video paths under `root`, skipping hidden/tracking/heavy dirs. */
function walkOcrable(root: string): string[] {
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
      } else if (ent.isFile() && ocrKindFor(ent.name)) {
        out.push(path.join(dir, ent.name));
      }
    }
  };
  try {
    fs.statSync(root).isDirectory() ? visit(root) : ocrKindFor(path.basename(root)) && out.push(root);
  } catch {
    /* unreadable root */
  }
  return out;
}

function summarizeOcr(results: OcrResult[]): OcrBatchResult {
  return {
    results,
    // `ocred` counts the empty-text successes too — they ARE successes (§2.3).
    ocred: results.filter((r) => r.status === "ocred").length,
    skipped: results.filter((r) => r.status === "skipped" || r.status === "needs_setup").length,
    failed: results.filter((r) => r.status === "failed" || r.status === "no_engine" || r.status === "needs_ffmpeg" || r.status === "unsupported").length,
  };
}
