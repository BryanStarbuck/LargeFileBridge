// TIMED ASR — the whisper.cpp engine, and the only LFB engine that produces WHEN as well as WHAT.
//
// ── WHY A FOURTH ENGINE ──────────────────────────────────────────────────────────────────────────
//
// LFB already had three (Apple SpeechAnalyzer, the Python `whisper` CLI, MLX qwen3-asr) and all three
// are driven for PLAIN TEXT: `--output_format txt`, a `.txt` read back, a word COUNT. None of them was
// asked for timings, so no timings existed, so there was nothing for a subtitle or a diarization file
// to be built out of. This engine exists to produce the canonical document of `segments.ts` with real
// segment boundaries and real per-word timings, which is the input every export needs.
//
// whisper.cpp is the right one to add rather than re-plumbing an existing engine:
//   * `whisper-cli -ojf` emits natural segments, each carrying per-token text, MILLISECOND offsets
//     and a per-token probability. That is segments + word timings + confidence in one pass.
//   * it is a single self-contained binary with a single `.bin` model, no Python environment;
//   * it runs on Metal on Apple Silicon (measured ~0.26× realtime on the large-v3-turbo q5_0 model);
//   * it is the same engine and the same model file the We The Citizens install uses, so the two
//     products' words are comparable rather than merely both present.
//
// The other three engines are NOT replaced and are not worse: they remain the right answer when
// whisper.cpp is not installed, and a plain-text result from any of them still becomes a valid
// canonical document through `docFromFlatText()` — with `has_timings: false` and a STATED gap, rather
// than a fabricated timeline.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandExists, spawnAsync, probeDurationSec, tryUnlink, nonEmpty } from "./audio-prep.js";
import {
  emptyDoc,
  finalizeDoc,
  type TranscriptDoc,
  type TranscriptSegment,
  type TranscriptWord,
} from "./segments.js";

/** The whisper.cpp CLI. Homebrew installs it as `whisper-cli`; older builds shipped `main`. */
export const WHISPER_CPP_BIN = "whisper-cli";

/** The model this engine runs. Large-v3-turbo q5_0: the accuracy/speed point the reference install uses. */
const MODEL_FILE = "whisper_large_v3_turbo_q5_0.bin";

/**
 * Where to look for the model, in order — same policy as `diarize.ts`, for the same reason: an env
 * override first, LFB's own state root next, and the We The Citizens model directory LAST so a
 * machine that already runs that product does not download a second 550 MB copy to prove ownership.
 */
export function modelSearchDirs(): string[] {
  const home = process.env.HOME || os.homedir();
  return [
    process.env.LFB_WHISPER_CPP_MODEL_DIR,
    path.join(home, "T", "_lfb", "models"),
    path.join(home, "T", "_wethecitizens", "models"),
  ].filter((d): d is string => typeof d === "string" && d.length > 0);
}

export function resolveWhisperCppModel(): string | null {
  const override = process.env.LFB_WHISPER_CPP_MODEL;
  if (override && nonEmpty(override)) return override;
  for (const dir of modelSearchDirs()) {
    const p = path.join(dir, MODEL_FILE);
    if (nonEmpty(p)) return p;
  }
  return null;
}

export type TimedAsrAvailability =
  | { ok: true; bin: string; model: string }
  | { ok: false; reason: "binary_missing" | "model_missing"; detail: string };

/** Can timed ASR run right now? A caller asks before promising timings. */
export function timedAsrAvailability(): TimedAsrAvailability {
  if (!commandExists(WHISPER_CPP_BIN)) {
    return {
      ok: false,
      reason: "binary_missing",
      detail: `${WHISPER_CPP_BIN} is not on PATH — \`brew install whisper-cpp\` provides it`,
    };
  }
  const model = resolveWhisperCppModel();
  if (!model) {
    return {
      ok: false,
      reason: "model_missing",
      detail: `${MODEL_FILE} not found — looked in ${modelSearchDirs().join(", ")} (override with LFB_WHISPER_CPP_MODEL)`,
    };
  }
  return { ok: true, bin: WHISPER_CPP_BIN, model };
}

/**
 * whisper.cpp reads 16 kHz mono PCM and NOTHING ELSE. Handing it an .m4a fails with a message about
 * the WAV header that does not obviously mean "convert it first", so this is always done rather than
 * attempted-and-retried. The temp file is the caller's to unlink; `diarizeWav` needs the same file, so
 * `rich.ts` converts once and passes the path to both stages instead of paying for two conversions.
 */
export async function toWav16kMono(inputFile: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `lfb-asr-${process.hrtime.bigint()}.wav`);
  const r = await spawnAsync(
    "ffmpeg",
    ["-nostdin", "-loglevel", "error", "-y", "-i", inputFile, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", tmp],
    { allowFail: true, label: `ffmpeg:${path.basename(inputFile)}` },
  );
  if (r.status !== 0 || !nonEmpty(tmp)) {
    tryUnlink(tmp);
    throw new Error((r.stderr || "").split("\n").slice(-3).join(" ").slice(0, 200) || "ffmpeg produced no wav");
  }
  return tmp;
}

/** One token as whisper.cpp's `-ojf` reports it. */
interface CppToken {
  text?: string;
  offsets?: { from?: number; to?: number };
  p?: number;
  t_dtw?: number;
}
interface CppSegment {
  text?: string;
  offsets?: { from?: number; to?: number };
  tokens?: CppToken[];
}

/**
 * A whisper.cpp token is a SUB-WORD PIECE, not a word: " Hey", "ll", "," are three tokens and the
 * last two belong to the word before them. A leading space is what marks the start of a new word, so
 * tokens are merged on that boundary. Without this the CTM export would list "ll" and "," as words
 * with their own timings, and any WER computed against it would be meaningless.
 *
 * Special tokens (`[_BEG_]`, `<|…|>`) carry no audio and are dropped. A word's timing spans its first
 * token's start to its last token's end; its confidence is the MINIMUM of its tokens' probabilities —
 * the pessimistic choice, because a word is only as trustworthy as its least certain piece.
 */
function tokensToWords(tokens: CppToken[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const t of tokens) {
    const raw = t.text ?? "";
    // ⚠️ THE BRACKET PATTERN IS `[_TT_314]`, NOT `[_TT_]`. An earlier version of this filter matched
    // `^\[_.*_\]$` — requiring a trailing underscore — so every timestamp token whose name ends in
    // digits sailed through and was concatenated onto the preceding word. It surfaced as literal
    // `[_TT_314]` inside the WebVTT cue text and as a bogus CTM token, i.e. in the two files an
    // outsider uses to measure our WER. Match `[_…]` and `<|…|>` on their delimiters only.
    if (!raw || /^\[_.*\]$/.test(raw) || /^<\|.*\|>$/.test(raw)) continue;
    const startsWord = raw.startsWith(" ") || words.length === 0;
    const piece = raw.trim();
    if (!piece) continue;
    // Prefer the DTW timestamp when the build produced one (t_dtw is -1 when DTW is unavailable,
    // e.g. under flash-attn); otherwise the token offsets, which are milliseconds.
    const from = t.t_dtw !== undefined && t.t_dtw >= 0 ? t.t_dtw / 100 : (t.offsets?.from ?? 0) / 1000;
    const to = (t.offsets?.to ?? t.offsets?.from ?? 0) / 1000;
    const conf = typeof t.p === "number" ? t.p : null;
    if (startsWord) {
      words.push({ w: piece, s: from, e: Math.max(from, to), c: conf });
      continue;
    }
    const last = words[words.length - 1];
    last.w += piece;
    last.e = Math.max(last.e, to);
    if (conf !== null) last.c = last.c === null ? conf : Math.min(last.c, conf);
  }

  // BACKFILL ZERO-LENGTH WORDS FROM THE NEXT WORD'S START. whisper.cpp frequently reports a token
  // whose `from` and `to` are the same millisecond, which is not a claim that the word was
  // instantaneous — it is the absence of an end estimate. Left alone it publishes `dur 0.000` in the
  // CTM, and `sclite` and every other scoring tool reads a zero-duration word as a degenerate
  // interval. The next word's start is the best-supported end for the word before it.
  for (let i = 0; i < words.length; i++) {
    if (words[i].e > words[i].s) continue;
    const nextStart = i + 1 < words.length ? words[i + 1].s : null;
    words[i].e = nextStart !== null && nextStart > words[i].s ? nextStart : words[i].s;
  }
  return words;
}

/** Mean word confidence under this is marked `low_conf` — a rendering hint, never a gate. */
const LOW_CONF_MEAN = 0.6;

/**
 * Transcribe with whisper.cpp and return the canonical document — WITHOUT a speaker layer. Speakers
 * are added by `rich.ts` from `diarize.ts`, because they come from a different model and must be able
 * to fail independently.
 *
 * `wavPath` must already be 16 kHz mono (see `toWav16kMono`). `canonicalId` becomes the id RTTM and
 * CTM print on every line, so it should be the media's stable key, not a temp filename.
 */
export async function transcribeTimed(
  wavPath: string,
  canonicalId: string,
  opts: { threads?: number; language?: string; onProgress?: (fraction: number) => void } = {},
): Promise<TranscriptDoc> {
  const avail = timedAsrAvailability();
  if (!avail.ok) throw new Error(avail.detail);

  const threads = Math.max(1, opts.threads ?? Math.min(8, Math.max(1, os.cpus().length - 2)));
  const language = opts.language ?? "en";
  const outBase = path.join(os.tmpdir(), `lfb-asrout-${process.hrtime.bigint()}`);
  const jsonPath = `${outBase}.json`;

  // `-ojf` (--output-json-full) is the flag that carries TOKENS; plain `-oj` gives segment text only
  // and would silently cost every word timing, the CTM export and the VTT inline timestamps.
  // `-dtw` asks for token-level DTW alignment; the build disables it under flash-attn and says so on
  // stderr, in which case the token offsets are still populated and `word_timing` records the weaker
  // provenance rather than claiming DTW.
  const args = [
    "-m", avail.model,
    "-f", wavPath,
    "-ojf",
    "-of", outBase,
    "-t", String(threads),
    "-l", language,
    "-dtw", "large.v3.turbo",
    "--no-prints",
  ];

  const r = await spawnAsync(WHISPER_CPP_BIN, args, {
    allowFail: true,
    label: `whisper-cpp:${canonicalId}`,
    onLine: (line) => {
      // whisper.cpp prints `whisper_print_progress_callback: progress = 45%` when progress is on.
      const m = /progress\s*=\s*(\d+)/.exec(line);
      if (m && opts.onProgress) opts.onProgress(Math.min(1, Number(m[1]) / 100));
    },
  });

  if (!nonEmpty(jsonPath)) {
    tryUnlink(jsonPath);
    throw new Error(
      `${WHISPER_CPP_BIN} exited ${r.status} and wrote no JSON: ${(r.stderr || "").split("\n").slice(-2).join(" ").slice(0, 200)}`,
    );
  }

  let parsed: { transcription?: CppSegment[]; model?: { type?: string }; params?: { language?: string } };
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } finally {
    tryUnlink(jsonPath);
  }

  const rawSegments = Array.isArray(parsed.transcription) ? parsed.transcription : [];

  // ── WHETHER DTW ACTUALLY ENGAGED IS OBSERVED, NOT PARSED FROM A LOG ──────────────────────────
  // whisper.cpp silently disables DTW when flash-attn is on ("dtw_token_timestamps is not supported
  // with flash_attn - disabling"), and an earlier version of this file detected that by grepping
  // stderr. That is unreliable in exactly the configuration we ship: `--no-prints` suppresses the
  // warning, the grep finds nothing, and the document then CLAIMS `word_timing: "dtw"` for timings
  // that are ordinary token offsets. Provenance that overstates itself is worse than no provenance,
  // so this reads the data instead: `t_dtw` is -1 on every token when DTW did not run.
  const dtwEngaged = rawSegments.some((cs) => (cs.tokens ?? []).some((t) => typeof t.t_dtw === "number" && t.t_dtw >= 0));

  const doc = emptyDoc(canonicalId);
  doc.source = "whisper_cpp";
  doc.language = parsed.params?.language ?? language;
  doc.duration_s = await probeDurationSec(wavPath);

  const segments: TranscriptSegment[] = [];
  let anyWords = false;
  for (const cs of rawSegments) {
    const text = (cs.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue; // whisper.cpp emits empty leading/trailing segments; they are not silence claims
    const words = tokensToWords(Array.isArray(cs.tokens) ? cs.tokens : []);
    if (words.length) anyWords = true;
    const confs = words.map((w) => w.c).filter((c): c is number => c !== null);
    const mean = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
    segments.push({
      i: segments.length,
      start_s: (cs.offsets?.from ?? 0) / 1000,
      end_s: (cs.offsets?.to ?? cs.offsets?.from ?? 0) / 1000,
      speaker: null,
      speaker_conf: null,
      // The speaker layer has not been attempted at this point in the pipeline. `rich.ts` overwrites
      // this per segment once diarization has run, or leaves it as the truthful record that it did not.
      speaker_cause: "no_diarization",
      low_conf: mean !== null && mean < LOW_CONF_MEAN,
      text,
      words,
    });
  }
  doc.segments = segments;
  doc.asr = {
    engine: "whisper.cpp",
    model: path.basename(avail.model),
    version: null,
    compute: process.platform === "darwin" && process.arch === "arm64" ? "metal" : "cpu",
    word_timing: anyWords ? (dtwEngaged ? "dtw" : "token_coarse") : "segment_only",
    segments: segments.length,
  };
  return finalizeDoc(doc);
}
