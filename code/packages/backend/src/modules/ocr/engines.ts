// OCR ENGINE ADAPTERS (ocr.mdx §3). Reads the text that is VISIBLE IN THE PIXELS of an image, at one of two
// recognition levels (ocr.mdx §2, the LOCKED two-speed rule):
//   • accurate — a standalone IMAGE. One file, one pass; accuracy is worth every millisecond (§16).
//   • fast     — a VIDEO FRAME. 160 frames per 40-minute clip; throughput is everything (§15).
//
// THE ENGINE IS A LIBRARY, NOT A `brew install` (ocr.mdx §3, the product directive). Both adapters arrive
// through `pnpm install` and are pinned in the lockfile — there is no tool for the user to provision, no
// consent dialog, no "Re-check" button, and no broken-PATH support surface. That is the whole reason this
// feature can be run over an entire tree.
//   • vision   (PRIMARY) — `mac-ocr`, an npm package shipping a prebuilt universal binary over Apple's
//     Vision framework (VNRecognizeTextRequest). On-device, no Xcode/Swift toolchain, no model download,
//     hardware-accelerated on Apple Silicon. Its `--fast` / accurate levels ARE our two speeds, which is
//     most of why it won: we expose a knob rather than inventing one.
//   • tesseract (FALLBACK) — `tesseract.js`, pure WASM. Keeps the feature alive off-Mac (the charter's
//     "server-side later" posture) and when the Vision binary won't run.
//
// OCR NEVER UPLOADS (ocr.mdx §4). Unlike AI description — the app's ONE deliberate network path — OCR is
// 100% local, so it needs no API key, no provider matrix, and no credentials popup. Any network call added
// to this module is a CHARTER VIOLATION. That is also why §3.3 matters: tesseract.js fetches its
// `traineddata` from a CDN on first use unless `langPath` is pointed at VENDORED local files, which would
// make the *fallback* phone home silently. We vendor it and pin the path.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OcrResult as MacOcrResult } from "mac-ocr";
import type { OcrBlock, OcrEngineId, OcrLevel, OcrEngineStatus } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { coreBudget, memoryBudget } from "../../shared/concurrency.js";
import { log } from "../../shared/logging.js";

/** One engine's recognition of ONE image. `text` may legitimately be "" — most images have no text, and
 *  that is a SUCCESS, not a failure (ocr.mdx §2.3, the load-bearing rule). */
export interface Recognition {
  text: string;
  blocks: OcrBlock[];
}

export interface OcrEngine {
  id: OcrEngineId;
  label: string;
  /** Is this engine usable on this computer right now? Cheap + cached — never a recognition. */
  available: () => boolean;
  recognize: (absImage: string, opts: { level: OcrLevel; language: string }) => Promise<Recognition>;
}

// ── The vendored Tesseract language data (ocr.mdx §3.3, LOCKED) ───────────────────────────────────────
// `langPath` MUST point at local files. Left unset, tesseract.js downloads <lang>.traineddata from a CDN on
// first use — i.e. the FALLBACK engine would make LFBridge phone home on a feature whose entire premise is
// that it does not. The offline pattern (tesseract.js-offline): vendor the data, pin the path, set
// gzip:false for uncompressed .traineddata files.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VENDORED_LANG_DIR = path.resolve(HERE, "../../../assets/tessdata");

/** Languages we ship data for. Anything else is a PERMISSIONED download (§3.3) — never silent. */
export function vendoredLanguages(): string[] {
  try {
    return fs
      .readdirSync(VENDORED_LANG_DIR)
      .filter((f) => f.endsWith(".traineddata"))
      .map((f) => f.replace(/\.traineddata$/, ""));
  } catch {
    return [];
  }
}

/** Vision speaks BCP-47 ("en-US"); Tesseract speaks ISO 639-2/T ("eng"). One config value, two dialects. */
const TESS_LANG: Record<string, string> = {
  en: "eng",
  "en-US": "eng",
  "en-GB": "eng",
  fr: "fra",
  "fr-FR": "fra",
  de: "deu",
  "de-DE": "deu",
  es: "spa",
  "es-ES": "spa",
  it: "ita",
  pt: "por",
  ja: "jpn",
  "ja-JP": "jpn",
  ko: "kor",
  zh: "chi_sim",
  "zh-CN": "chi_sim",
};

function tesseractLang(bcp47: string): string {
  return TESS_LANG[bcp47] ?? TESS_LANG[bcp47.split("-")[0]] ?? "eng";
}

// ── Availability probes (cached) ──────────────────────────────────────────────────────────────────────
// Deliberately cheap and SYNCHRONOUS: these are import-resolution checks worth a few ms, the same exception
// the compression engine makes for `onPath()`. Everything that touches a file or a child process on the OCR
// hot path is async (ocr.mdx §10.4).
let visionProbe: boolean | null = null;
let tesseractProbe: boolean | null = null;

function visionAvailable(): boolean {
  if (visionProbe !== null) return visionProbe;
  // macOS only — Vision is part of the OS. On any other platform the package's binary cannot run, and the
  // honest answer is "not available", which routes to the fallback (§3.2).
  if (process.platform !== "darwin") {
    visionProbe = false;
    return false;
  }
  try {
    // Resolve-only: does the dependency exist in this install? A real recognition would cost ~250ms and is
    // not what an availability probe is for.
    createRequire(import.meta.url).resolve("mac-ocr");
    visionProbe = true;
  } catch {
    log.warn("ocr", "mac-ocr is not installed — Apple Vision OCR is unavailable; falling back to tesseract.js");
    visionProbe = false;
  }
  return visionProbe;
}

function tesseractAvailable(): boolean {
  if (tesseractProbe !== null) return tesseractProbe;
  try {
    createRequire(import.meta.url).resolve("tesseract.js");
    // An engine whose language data isn't vendored is only "available" for a vendored language — and with no
    // data at all it cannot run offline, which is the only way we are allowed to run it (§3.3/§4).
    if (vendoredLanguages().length === 0) {
      log.warn("ocr", `tesseract.js is installed but no vendored language data was found at ${VENDORED_LANG_DIR} — the fallback engine would have to download it (ocr.mdx §3.3), so it is reported unavailable.`);
      tesseractProbe = false;
    } else {
      tesseractProbe = true;
    }
  } catch {
    tesseractProbe = false;
  }
  return tesseractProbe;
}

// ── The vision adapter — Apple Vision via mac-ocr (PRIMARY) ───────────────────────────────────────────
const vision: OcrEngine = {
  id: "vision",
  label: "Apple Vision",
  available: visionAvailable,
  async recognize(absImage, { level, language }) {
    const { ocr } = await import("mac-ocr");
    // mac-ocr takes BYTES, not a path — "Read files or fetch URLs in your own code and pass the bytes."
    // The read is `fs.promises`, never readFileSync: on a wide fan-out a synchronous read of a frame or a
    // 4K screenshot blocks the event loop exactly as hard as a spawnSync would (ocr.mdx §10.4, P-27/T3).
    const bytes = await fsp.readFile(absImage);
    const r = await ocr(bytes, {
      // THE TWO SPEEDS (ocr.mdx §2, LOCKED). This is the whole reason Vision won the engine bake-off: our
      // product rule and the engine's native knob are the SAME knob.
      fast: level === "fast",
      languages: [language],
      // Correction ON for a standalone image — it turns rn→m and 0→O confusions into words a user will
      // actually search for (§16.2 rule 2). OFF for a video frame: at 160 frames it is the wrong trade.
      languageCorrection: level === "accurate",
    });
    return normalizeVision(r);
  },
};

/** mac-ocr's `boundingBox` is ALREADY normalized 0–1 with a top-left origin — exactly the shape §5.1
 *  publishes, so the viewer can overlay a hit at any render size with no image dimensions in hand. */
function normalizeVision(r: MacOcrResult): Recognition {
  const blocks: OcrBlock[] = r.observations
    .map((o) => ({
      text: o.text.trim(),
      confidence: o.confidence,
      bbox: [o.boundingBox.x, o.boundingBox.y, o.boundingBox.width, o.boundingBox.height] as [number, number, number, number],
    }))
    .filter((b) => b.text !== "");
  // `r.text` is "every observation's text joined by newlines" — and may legitimately be "" (§2.3).
  return { text: r.text.trim(), blocks };
}

// ── The tesseract adapter — pure WASM (FALLBACK) ──────────────────────────────────────────────────────
//
// THE WORKER POOL IS NOT AN OPTIMIZATION — IT IS THE §10.4 RULE (LOCKED).
// tesseract.js recognition is a multi-second CPU-bound WASM call. Run on the main thread it freezes the Node
// event loop exactly as hard as the `spawnSync` that made the Processing page unloadable during a 2,000-file
// describe run (performance.mdx P-27, theme T3) — but with NO child process to blame, so it would be far
// harder to diagnose. It runs in the library's worker pool, always.
//
// Workers are also REUSED across files: the library's own guidance is that "each worker uses a high amount of
// memory, so code should never be able to create an arbitrary number of workers", and at ~250ms of real work
// per image a per-file worker spawn would dominate the run (§16.2 rule 6).
//
// And the pool must be a POOL, not a worker (§10.4 / §16.2 rule 6). ONE worker per language serializes every
// recognition behind it: `ocr:image` fans `coreBudget()` jobs wide (ocr.service.ts), and a single worker would
// quietly collapse that fan-out to ~1 core no matter the budget — the engine would look "parallel" and run
// like a queue. tesseract.js's own answer is `createScheduler()`: N workers, one FIFO, `addJob` dispatches to
// whichever worker is idle. So the pool is sized to the SAME mass-compute budget the caller fans out with —
// one definition of "how parallel", no second drifting core math (parallelization.mdx §1).
type TessScheduler = ReturnType<typeof import("tesseract.js").createScheduler>;

/**
 * How many tesseract workers the pool may hold — bounded by CORES **and** MEMORY (memory.mdx §2.5).
 *
 * Cores alone is the wrong axis, and this app has the scar: the describe queue admitted 24 uploads purely by
 * COUNT on the theory that a network-bound job has "no hardware bottleneck" — true for CPU, false for memory,
 * and 24 × ~66-90MB of pinned base64 is what reached a 4.1GB heap and killed the process (jobqueue.service.ts
 * header, crash_recovery.mdx §2). A tesseract.js worker is a WASM instance carrying its own heap and a loaded
 * ~4MB language model; on a 24-core box, `coreBudget()` alone would spin up ~21 of them the first time a
 * single Linux image fell back to tesseract. Same mistake, different units.
 *
 * So the pool takes the MIN of the two budgets: never more workers than the mass-compute budget allows, and
 * never more than the memory budget can hold at TESS_WORKER_HEAP_BYTES each. Always at least 1 — a pool of
 * zero would make the fallback engine silently unavailable on a small machine, which is worse than slow.
 */
const TESS_WORKER_HEAP_BYTES = 200 * 1024 * 1024; // ~200MB per WASM worker (model + scratch), measured coarsely
function tessPoolSize(): number {
  const byCores = coreBudget();
  const byMemory = Math.floor(memoryBudget() / TESS_WORKER_HEAP_BYTES);
  return Math.max(1, Math.min(byCores, byMemory));
}

// Keyed by language: a scheduler's workers are initialized for ONE language, and a second language is a
// second pool rather than a reinitialize storm.
const schedulerPool = new Map<string, Promise<TessScheduler>>();

async function tessSchedulerFor(lang: string): Promise<TessScheduler> {
  let s = schedulerPool.get(lang);
  if (!s) {
    // Lazily built and memoized as a PROMISE, so concurrent first callers await one construction rather than
    // racing to spin up 2×N workers. Nothing starts unless tesseract actually runs — on a Mac the fallback
    // never fires and this whole block stays cold.
    s = (async () => {
      const { createScheduler, createWorker } = await import("tesseract.js");
      const size = tessPoolSize();
      log.info("ocr", `starting tesseract.js scheduler (lang=${lang}, ${size} workers, vendored data at ${VENDORED_LANG_DIR})`);
      const scheduler = createScheduler();
      // langPath pinned to the VENDORED directory + cacheMethod "none" — the fallback MUST work with the
      // network unplugged (§3.3). Left at its defaults, tesseract.js fetches <lang>.traineddata from a CDN on
      // first use, which would make the fallback engine phone home on a feature whose entire premise (§4) is
      // that it does not. `gzip: false` because the vendored files are uncompressed .traineddata.
      const workers = await Promise.all(
        Array.from({ length: size }, () =>
          createWorker(lang, 1, { langPath: VENDORED_LANG_DIR, gzip: false, cacheMethod: "none" }),
        ),
      );
      for (const w of workers) scheduler.addWorker(w);
      return scheduler;
    })();
    schedulerPool.set(lang, s);
  }
  return s;
}

/** Terminate the pooled workers (process shutdown / tests). Safe to call when the pool is empty.
 *  `scheduler.terminate()` terminates every worker it holds, so there is no separate worker list to track. */
export async function shutdownOcrWorkers(): Promise<void> {
  const schedulers = [...schedulerPool.values()];
  schedulerPool.clear();
  await Promise.allSettled(schedulers.map(async (p) => (await p).terminate()));
}

const tesseract: OcrEngine = {
  id: "tesseract",
  label: "Tesseract (fallback)",
  available: tesseractAvailable,
  async recognize(absImage, { language }) {
    // NOTE: tesseract.js has no first-class fast/accurate switch (§3.1's table), so this adapter ignores
    // `level`. The two-speed rule is still honored where it actually matters — a video is SAMPLED at a 15s
    // stride rather than fully decoded — so the fallback is slower per frame but never asymptotically wrong.
    const scheduler = await tessSchedulerFor(tesseractLang(language));
    // ImageLike accepts a path in Node, so unlike Vision there is no read to do here. `addJob` queues onto
    // the pool and resolves on whichever worker took it — the caller's wide fan-out actually runs wide.
    const { data } = await scheduler.addJob("recognize", absImage);
    // v7 has NO `data.words`: the hierarchy is blocks → paragraphs → lines → words, and `blocks` is null
    // unless block output is enabled. We publish LINE-level blocks — the granularity a reader actually wants
    // — and no bbox: tesseract's boxes are in PIXELS and `Page` carries no image dimensions to normalize
    // against, and §5.1 publishes normalized boxes or none. Never a pixel box mislabelled as normalized.
    const blocks: OcrBlock[] = (data.blocks ?? [])
      .flatMap((b) => b.paragraphs ?? [])
      .flatMap((p) => p.lines ?? [])
      .map((l) => ({
        text: (l.text ?? "").trim(),
        confidence: typeof l.confidence === "number" ? l.confidence / 100 : null,
        bbox: null,
      }))
      .filter((b) => b.text !== "");
    return { text: (data.text ?? "").trim(), blocks };
  },
};

export const ENGINES: OcrEngine[] = [vision, tesseract];

/**
 * Which engine runs: an explicit request, else the configured default, else the first AVAILABLE one in
 * preference order (vision → tesseract). Auto-fallback mirrors transcription's qwen→whisper chain
 * (transcribe_engine.mdx) — a machine without Vision quietly gets Tesseract rather than an error.
 * Returns null only when NOTHING is available (§6's `no_engine`).
 */
export function selectEngine(requested?: OcrEngineId | "auto"): OcrEngine | null {
  if (requested && requested !== "auto") {
    const e = ENGINES.find((x) => x.id === requested);
    // An explicitly requested engine that isn't available falls back rather than failing: the user asked for
    // OCR, and the engine is an implementation detail we record in the artifact (§5.1) so the choice stays
    // auditable (`ocr-fallback-engine-in-use`, warnings §10.11).
    if (e?.available()) return e;
  }
  const configured = getAppConfig().ocr?.engine ?? "auto";
  if (configured !== "auto") {
    const e = ENGINES.find((x) => x.id === configured);
    if (e?.available()) return e;
  }
  return ENGINES.find((e) => e.available()) ?? null;
}

/** The engine matrix for Settings → Tools (ocr.mdx §17) and the readiness gate (§6). Never recognizes. */
export function engineStatus(): OcrEngineStatus[] {
  return ENGINES.map((e) => ({ id: e.id, label: e.label, available: e.available() }));
}

/** The configured OCR language (BCP-47), defaulting to US English. */
export function ocrLanguage(): string {
  return getAppConfig().ocr?.language ?? "en-US";
}
