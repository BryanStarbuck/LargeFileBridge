// SPEAKER DIARIZATION — "who spoke when", the layer LFB transcription did not have at all.
//
// ── WHAT THIS ADDS, AND WHY IT IS A SEPARATE STAGE ───────────────────────────────────────────────
//
// ASR answers "what words". Diarization answers "how many people, and which stretches are each of
// them". They are different models over the same audio and neither implies the other, which is why
// this is its own module and its own failure domain: a diarization failure must cost the SPEAKER
// LAYER and never the words. `rich.ts` enforces that — it transcribes first, writes the words, and
// treats the speaker layer as an enrichment that may be absent with a stated cause.
//
// ── THE ENGINE, AND WHY THIS ONE ─────────────────────────────────────────────────────────────────
//
// sherpa-onnx's offline speaker diarization: pyannote segmentation 3.0 for "is somebody speaking,
// and is it a different somebody", then a speaker-embedding model per turn, then clustering of those
// embeddings. It is the same stack, the same two model files and the same configuration the We The
// Citizens install runs, which is deliberate: the two products' speaker layers should be comparable
// rather than merely both present.
//
// TWO PACKAGES WEAR ALMOST THE SAME NAME AND THE DIFFERENCE IS ~4×:
//   `sherpa-onnx`      — the WebAssembly build. FACTORY functions (`createOfflineSpeakerDiarization`),
//                        single-threaded, and `numThreads` does nothing.
//   `sherpa-onnx-node` — the native N-API addon. CLASS constructors (`new OfflineSpeakerDiarization`)
//                        and real threading.
// Measured in the reference install on 74.6 s of audio with identical output: WASM 55.8 s, native
// 1-thread 29.0 s, native 4-thread 14.8 s. Both surfaces are accepted below because the WASM build is
// a legitimate fallback where the addon cannot build, and WHICH ONE RAN is recorded in the document's
// provenance — a reader comparing two runs' speaker layers is entitled to know they came from the
// same engine.
//
// ── IT IS AN OPTIONAL DEPENDENCY, ON PURPOSE ─────────────────────────────────────────────────────
//
// `sherpa-onnx-node` is a native addon with a per-platform binary, and the two model files are ~100 MB
// that nothing downloads without being asked. On a machine where either is missing, LFB must still
// transcribe — so the import is DYNAMIC and every absence returns a typed, reportable reason instead
// of throwing. `diarizeAvailability()` is what a CLI or a settings page asks before promising a
// speaker layer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A raw turn as the diarizer reports it: seconds against the whole media, plus a cluster ordinal. */
export interface DiarTurn {
  start: number;
  end: number;
  /** The cluster index the library assigned. Rendered as `SPEAKER_00`, `SPEAKER_01`, … */
  speaker: number;
}

export interface DiarizeResult {
  turns: DiarTurn[];
  /** "sherpa-onnx-node" | "sherpa-onnx" — which build actually ran, for the provenance line. */
  engine: string;
  segModel: string;
  embModel: string;
  threshold: number | null;
  numClustersForced: number | null;
  /**
   * pyannote-segmentation-3.0 as driven here does NOT report overlapping speech. This is false and
   * it MEANS "we did not look" — never "there was no crosstalk". Every export that can carry a note
   * says so once at its top.
   */
  overlapDetection: false;
}

/** Why diarization cannot run right now, in a form a UI can show and a log can be grepped for. */
export type DiarUnavailableReason =
  | { kind: "addon_missing"; detail: string }
  | { kind: "models_missing"; detail: string; missing: string[] };

export type DiarAvailability = { ok: true; engine: string; segModel: string; embModel: string } | ({ ok: false } & DiarUnavailableReason);

/** The two model files, by the filenames the reference install uses. */
const SEG_MODEL_FILE = "sherpa_pyannote_segmentation_3_0.bin";
const EMB_MODEL_FILE = "eres2net_base_3dspeaker_16k.bin";

/**
 * Where to look for the two models, in order. First hit wins.
 *
 * The env overrides come first so an operator can point at a model without moving files. LFB's own
 * state root is next — the place a future `lfb transcribe-install` would put them. LAST is the We The
 * Citizens model directory: on a machine that already runs that product the models are ALREADY THERE,
 * and re-downloading 100 MB to a second location to say we own it would be worse for the user than
 * reading the file that exists. It is read-only reuse of a local file, nothing more.
 */
export function modelSearchDirs(): string[] {
  const home = process.env.HOME || os.homedir();
  return [
    process.env.LFB_DIARIZE_MODEL_DIR,
    path.join(home, "T", "_lfb", "models"),
    path.join(home, "T", "_wethecitizens", "models"),
  ].filter((d): d is string => typeof d === "string" && d.length > 0);
}

function findModel(file: string, override?: string): string | null {
  if (override && fs.existsSync(override)) return override;
  for (const dir of modelSearchDirs()) {
    const p = path.join(dir, file);
    try {
      if (fs.statSync(p).size > 0) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function resolveDiarModels(): { segModel: string | null; embModel: string | null; missing: string[] } {
  const segModel = findModel(SEG_MODEL_FILE, process.env.LFB_DIARIZE_SEG_MODEL);
  const embModel = findModel(EMB_MODEL_FILE, process.env.LFB_DIARIZE_EMB_MODEL);
  const missing: string[] = [];
  if (!segModel) missing.push(SEG_MODEL_FILE);
  if (!embModel) missing.push(EMB_MODEL_FILE);
  return { segModel, embModel, missing };
}

/** The union of the two builds' surfaces. Every call goes through `construct()` below. */
interface SherpaModule {
  readWave(p: string): { samples: Float32Array; sampleRate: number };
  OfflineSpeakerDiarization?: new (cfg: unknown) => { process(samples: Float32Array): unknown };
  createOfflineSpeakerDiarization?: (cfg: unknown) => { process(samples: Float32Array): unknown };
}

interface LoadedRuntime {
  mod: SherpaModule;
  packageName: string;
}

/**
 * Load whichever sherpa build is installed, native first. Returns null when neither is — which is a
 * normal state on a machine that has not installed the optional addon, not an error to throw.
 */
async function loadSherpa(): Promise<LoadedRuntime | null> {
  for (const name of ["sherpa-onnx-node", "sherpa-onnx"]) {
    try {
      // Dynamic + variable so a bundler cannot hard-require an optional native addon, and so the
      // absence of the addon is a caught rejection rather than a module-load crash.
      const mod = (await import(/* @vite-ignore */ name)) as { default?: SherpaModule } & SherpaModule;
      const m = (mod.default ?? mod) as SherpaModule;
      const usable = typeof m.OfflineSpeakerDiarization === "function" || typeof m.createOfflineSpeakerDiarization === "function";
      if (usable && typeof m.readWave === "function") return { mod: m, packageName: name };
    } catch {
      /* try the next build */
    }
  }
  return null;
}

/** Can diarization run right now? Ask before promising a speaker layer. */
export async function diarizeAvailability(): Promise<DiarAvailability> {
  const rt = await loadSherpa();
  if (!rt) {
    return {
      ok: false,
      kind: "addon_missing",
      detail: "neither sherpa-onnx-node nor sherpa-onnx resolves — install the optional dependency to get a speaker layer",
    };
  }
  const { segModel, embModel, missing } = resolveDiarModels();
  if (!segModel || !embModel) {
    return {
      ok: false,
      kind: "models_missing",
      missing,
      detail: `missing ${missing.join(" and ")} — looked in ${modelSearchDirs().join(", ")}`,
    };
  }
  return { ok: true, engine: rt.packageName, segModel, embModel };
}

function construct(rt: LoadedRuntime, cfg: unknown): { process(samples: Float32Array): unknown } {
  if (typeof rt.mod.OfflineSpeakerDiarization === "function") return new rt.mod.OfflineSpeakerDiarization(cfg);
  if (typeof rt.mod.createOfflineSpeakerDiarization === "function") return rt.mod.createOfflineSpeakerDiarization(cfg);
  throw new Error("sherpa build exposes no offline speaker diarization surface");
}

/**
 * DIARIZE a 16 kHz mono WAV. Returns turns in seconds against the whole file.
 *
 * `maxSpeakers` constrains the clustering to a KNOWN speaker count when a caller genuinely knows it
 * (a two-person interview). Otherwise the library's own cosine threshold is the honest answer, and
 * guessing a count is worse than not constraining: forcing 2 clusters on a montage merges three
 * voices into two and every export then renders a confident lie.
 *
 * Exactly one of the two clustering modes may be set — passing both is a configuration error the
 * library resolves silently in a direction we should not depend on.
 */
export async function diarizeWav(
  wavPath: string,
  opts: { maxSpeakers?: number | null; numThreads?: number } = {},
): Promise<{ ok: true; result: DiarizeResult } | ({ ok: false } & DiarUnavailableReason) | { ok: false; kind: "failed"; detail: string }> {
  const avail = await diarizeAvailability();
  if (!avail.ok) return avail;
  const rt = await loadSherpa();
  if (!rt) return { ok: false, kind: "addon_missing", detail: "sherpa vanished between the probe and the call" };

  const numThreads = Math.max(1, opts.numThreads ?? Math.min(4, Math.max(1, os.cpus().length - 2)));
  const forced = opts.maxSpeakers && opts.maxSpeakers > 0 ? opts.maxSpeakers : null;
  const threshold = forced === null ? 0.5 : null;
  const clustering: Record<string, unknown> = forced === null ? { threshold: 0.5 } : { numClusters: forced };

  // ⚠️ `numThreads` reaches the library ONLY inside the `segmentation` and `embedding` sub-configs. A
  // top-level `numThreads` is ACCEPTED AND SILENTLY IGNORED — verified empirically in the reference
  // install, where it was the difference between 29 s and 15 s on the same clip.
  const cfg = {
    segmentation: { pyannote: { model: avail.segModel }, numThreads },
    embedding: { model: avail.embModel, numThreads },
    clustering,
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  };

  try {
    const sd = construct(rt, cfg);
    const wave = rt.mod.readWave(wavPath);
    const raw = sd.process(wave.samples) as unknown;
    // ⚠️ `process()` RETURNS THE ARRAY on both builds — a plain `[{start, end, speaker}, …]`, NOT a
    // `{ segments: [...] }` wrapper. A `.segments ?? []` here evaluates to `[]` on every call and
    // produces a well-formed EMPTY answer, which every downstream stage handles correctly as "no
    // speakers" — so the bug would be completely invisible. Both shapes are accepted so a binding
    // that grows the wrapper later cannot re-break it.
    const arr: unknown = Array.isArray(raw) ? raw : ((raw as { segments?: unknown })?.segments ?? []);
    const turns: DiarTurn[] = (Array.isArray(arr) ? arr : [])
      .map((t) => {
        const o = t as { start?: number; end?: number; speaker?: number };
        return { start: Number(o.start ?? 0), end: Number(o.end ?? 0), speaker: Number(o.speaker ?? 0) };
      })
      .filter((t) => Number.isFinite(t.start) && Number.isFinite(t.end) && t.end > t.start)
      .sort((a, b) => a.start - b.start);

    return {
      ok: true,
      result: {
        turns,
        engine: rt.packageName,
        segModel: path.basename(avail.segModel),
        embModel: path.basename(avail.embModel),
        threshold,
        numClustersForced: forced,
        overlapDetection: false,
      },
    };
  } catch (e) {
    // The words are already safe by the time this runs (see the module header). Report and degrade.
    return { ok: false, kind: "failed", detail: (e as Error).message.slice(0, 300) };
  }
}

/** `SPEAKER_00`, `SPEAKER_01`, … — the label convention every diarization tool and RTTM reader expects. */
export function speakerLabel(index: number): string {
  return `SPEAKER_${String(index).padStart(2, "0")}`;
}
