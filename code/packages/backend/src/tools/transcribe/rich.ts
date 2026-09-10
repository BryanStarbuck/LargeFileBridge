// THE RICH TRANSCRIPTION PIPELINE — one media file in, a complete set of transcript files out.
//
// ── THE ORDER OF OPERATIONS IS THE DESIGN ────────────────────────────────────────────────────────
//
//   1. convert to 16 kHz mono WAV   (once — both later stages read the same file)
//   2. ASR                          -> the words, with segment and word timings
//   3. WRITE THE WORDS              <- the authority is on disk from here on
//   4. diarize                      -> who spoke when, merged into the segments
//   5. write the sidecar + formats  -> .segments.json and the seven standard exports
//
// STEP 3 IS DELIBERATELY BEFORE STEP 4, and that ordering is the whole lesson of the run that
// prompted this module. A We The Citizens batch of 20 videos produced ZERO transcripts because the
// app died during DIARIZATION — the ASR had already finished and the words were sitting in memory,
// and every one of them was lost because nothing had been written yet. Diarization is the longest,
// most memory-hungry and least reliable stage, and it is an ENRICHMENT: a file that has words and no
// speaker layer is useful, and a file that has neither is not. So the words land first, and a
// diarization failure downgrades the result instead of discarding it.
//
// ── WHAT "DEGRADED" MEANS, PRECISELY ─────────────────────────────────────────────────────────────
//
// Every stage can be absent, and each absence has a typed cause that reaches the caller AND the
// files:
//   * no whisper.cpp        -> fall back to the existing engine chain for plain text; the document
//                              is built with `has_timings: false` and a stated gap. The .srt/.vtt/
//                              .ctm are then NOT written, because a subtitle file with no timings is
//                              a file of cues at second zero, which is a lie a player renders
//                              perfectly. The .script.txt and .fountain ARE written — they degrade
//                              honestly to "(UNTIMED)" turns.
//   * no diarizer or models -> the words, the timings and every timing-based format are written; the
//                              speaker layer is absent, `no_speakers_captured` is in `gaps[]`, and
//                              every script cue reads UNIDENTIFIED SPEAKER.
// A gap that is stated is a fact a reader can act on. A gap that is silently filled is not.
import fs from "node:fs";
import path from "node:path";
import { log } from "../../shared/logging.js";
import { probeDurationSec, tryUnlink, isTranscribableExt } from "./audio-prep.js";
import { diarizeWav, speakerLabel, type DiarTurn } from "./diarize.js";
import {
  EXPORT_FORMATS,
  EXPORT_SUFFIX,
  countWords,
  exportAs,
  toFlatTranscript,
  type ExportFormat,
} from "./exporters.js";
import {
  docFromFlatText,
  finalizeDoc,
  sha256,
  type TranscriptDoc,
} from "./segments.js";
import { timedAsrAvailability, toWav16kMono, transcribeTimed } from "./timed-asr.js";
import { transcribeWithEngine, type EnginePreference } from "./engine.js";

export interface RichTranscribeOptions {
  /** The stable key for this media. Becomes every output file's stem and the RTTM/CTM id. */
  key: string;
  /** Directory the files are written into. Created if absent. */
  outDir: string;
  title?: string | null;
  /** ISO date the media was RECORDED. NEVER inferred from today — omit it if unknown. */
  recordedOn?: string | null;
  /** Constrain clustering to a known speaker count. Omit unless genuinely known. */
  maxSpeakers?: number | null;
  /** Skip the speaker layer entirely (e.g. a single-speaker dictation). */
  noDiarize?: boolean;
  /** Fallback plain-text engine preference when whisper.cpp is unavailable. */
  fallbackEngine?: EnginePreference;
  onStage?: (stage: string, detail?: string) => void;
}

export interface RichTranscribeResult {
  status: "ok" | "no_audio" | "failed";
  key: string;
  outDir: string;
  /** Absolute paths actually written, by format name. A file not written is NOT listed. */
  files: Record<string, string>;
  words: number;
  durationS: number | null;
  hasTimings: boolean;
  hasSpeakers: boolean;
  speakers: number;
  diarTurns: number;
  /** Every degradation, in plain sentences, for the status report. Empty on a fully rich result. */
  notes: string[];
  reason: string | null;
  elapsedS: number;
}

/**
 * Assign each ASR segment a speaker by MAXIMUM TEMPORAL OVERLAP with the diarization turns.
 *
 * Midpoint containment is the obvious alternative and it is worse at exactly the moment that matters:
 * at a speaker change the ASR segment straddles the boundary, its midpoint lands in whichever turn
 * happens to hold the centre, and the segment is attributed to a person who spoke two words of it.
 * Overlap area is the honest measure of "whose segment is this mostly".
 *
 * A segment that overlaps NO turn gets `speaker: null` and cause `no_turn_overlap` — the diarizer
 * genuinely found no speech there (music, applause, a sponsor sting). That is a refusal, and it is
 * why the RTTM for such a stretch is empty rather than guessed.
 */
function attributeSpeakers(doc: TranscriptDoc, turns: DiarTurn[]): void {
  for (const seg of doc.segments) {
    if (seg.start_s === null || seg.end_s === null) {
      seg.speaker = null;
      seg.speaker_conf = null;
      seg.speaker_cause = "no_turn_overlap";
      continue;
    }
    let best: { speaker: number; overlap: number } | null = null;
    let total = 0;
    for (const t of turns) {
      const overlap = Math.min(seg.end_s, t.end) - Math.max(seg.start_s, t.start);
      if (overlap <= 0) continue;
      total += overlap;
      if (!best || overlap > best.overlap) best = { speaker: t.speaker, overlap };
    }
    if (!best) {
      seg.speaker = null;
      seg.speaker_conf = null;
      seg.speaker_cause = "no_turn_overlap";
      continue;
    }
    seg.speaker = speakerLabel(best.speaker);
    seg.speaker_cause = null;
    // `high` when one voice clearly owns the segment, `low` when the segment is split across turns.
    // This is a confidence INPUT for a reader, never a gate — a `low` segment is still quotable and
    // still attributed, it simply says the boundary was contested.
    const segLen = Math.max(1e-6, seg.end_s - seg.start_s);
    const dominance = best.overlap / segLen;
    const contested = total > best.overlap * 1.25;
    seg.speaker_conf = dominance >= 0.75 && !contested ? "high" : "low";
  }
}

function writeFileAtomic(target: string, body: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, target);
}

/**
 * Transcribe one media file into a complete file set.
 *
 * Never throws for an expected condition — an unreadable file, a missing engine, a diarizer that
 * errored all come back as a result with a `reason` and `notes`, because the caller is usually a
 * batch and one bad file must not end it.
 */
export async function transcribeRich(inputFile: string, opts: RichTranscribeOptions): Promise<RichTranscribeResult> {
  const started = Date.now();
  const stage = (s: string, d?: string): void => opts.onStage?.(s, d);
  const notes: string[] = [];
  const files: Record<string, string> = {};
  const base = (): RichTranscribeResult => ({
    status: "failed",
    key: opts.key,
    outDir: opts.outDir,
    files,
    words: 0,
    durationS: null,
    hasTimings: false,
    hasSpeakers: false,
    speakers: 0,
    diarTurns: 0,
    notes,
    reason: null,
    elapsedS: (Date.now() - started) / 1000,
  });

  if (!fs.existsSync(inputFile)) return { ...base(), reason: `input does not exist: ${inputFile}` };
  if (!isTranscribableExt(inputFile)) return { ...base(), reason: `not a transcribable extension: ${path.extname(inputFile)}` };

  fs.mkdirSync(opts.outDir, { recursive: true });
  const durationS = await probeDurationSec(inputFile);

  let wav: string | null = null;
  let doc: TranscriptDoc;
  const timed = timedAsrAvailability();

  try {
    if (timed.ok) {
      stage("convert", "16 kHz mono wav");
      wav = await toWav16kMono(inputFile);
      stage("asr", `whisper.cpp ${path.basename(timed.model)}`);
      doc = await transcribeTimed(wav, opts.key, { onProgress: (f) => stage("asr", `${Math.round(f * 100)}%`) });
    } else {
      // ── THE HONEST FALLBACK ──────────────────────────────────────────────────────────────────
      // No timed engine, so use the engine chain LFB already had and accept a document with no
      // timings. This is a real downgrade and it is NAMED in `notes` so the status report says so
      // rather than letting a caller assume the .srt is missing for some other reason.
      notes.push(`timed ASR unavailable (${timed.detail}) — fell back to plain text, so there are no timings and no subtitle/CTM exports`);
      stage("asr", "plain-text fallback engine");
      const tmpOut = path.join(opts.outDir, `${opts.key}.flat.tmp`);
      const r = await transcribeWithEngine(inputFile, tmpOut, { engine: opts.fallbackEngine ?? "auto" });
      if (r.status === "no_audio") {
        tryUnlink(tmpOut);
        return { ...base(), status: "no_audio", durationS, reason: r.reason ?? "no audio stream" };
      }
      if (r.status !== "transcribed" || !r.outputPath || !fs.existsSync(r.outputPath)) {
        tryUnlink(tmpOut);
        return { ...base(), durationS, reason: r.reason ?? `fallback engine returned ${r.status}` };
      }
      const flat = fs.readFileSync(r.outputPath, "utf8");
      tryUnlink(r.outputPath);
      doc = docFromFlatText(opts.key, flat, "mixed");
      doc.asr.engine = `lfb:${r.engineUsed}`;
      doc.duration_s = durationS;
    }
  } catch (e) {
    if (wav) tryUnlink(wav);
    return { ...base(), durationS, reason: `asr failed: ${(e as Error).message}` };
  }

  doc.duration_s = doc.duration_s ?? durationS;

  // ── STEP 3 — THE WORDS LAND NOW, BEFORE THE RISKY STAGE ────────────────────────────────────────
  const flatText = toFlatTranscript(doc);
  if (!flatText.trim()) {
    if (wav) tryUnlink(wav);
    // An empty transcript is NOT written. A zero-byte `.transcription` claims a file was transcribed
    // when nothing was said or nothing was heard, and a later reader cannot tell those apart.
    return { ...base(), durationS: doc.duration_s, reason: "the engine produced no usable text — nothing was written" };
  }
  const transcriptPath = path.join(opts.outDir, `${opts.key}.transcription`);
  writeFileAtomic(transcriptPath, flatText);
  files.transcription = transcriptPath;
  doc.text_sha256 = sha256(fs.readFileSync(transcriptPath));
  const words = countWords(flatText);
  stage("words", `${words} words written`);

  // ── STEP 4 — THE SPEAKER LAYER, WHICH MAY FAIL WITHOUT COSTING THE WORDS ───────────────────────
  let diarTurns = 0;
  if (opts.noDiarize) {
    notes.push("diarization was skipped by request — every cue reads UNIDENTIFIED SPEAKER");
  } else if (!wav) {
    notes.push("diarization needs a decoded wav and the plain-text fallback produced none — no speaker layer");
  } else {
    stage("diarize", `clustering ${Math.round(doc.duration_s ?? 0)} s — this stage reports once, on completion`);
    const d = await diarizeWav(wav, { maxSpeakers: opts.maxSpeakers ?? null });
    if (d.ok) {
      diarTurns = d.result.turns.length;
      attributeSpeakers(doc, d.result.turns);
      doc.diar = {
        engine: d.result.engine,
        seg_model: d.result.segModel,
        emb_model: d.result.embModel,
        turns: diarTurns,
        clusters: 0, // finalizeDoc derives this from the segments actually attributed
        overlap_detection: d.result.overlapDetection,
        num_clusters_forced: d.result.numClustersForced,
        threshold: d.result.threshold,
      };
      stage("diarize", `${diarTurns} turns`);
    } else {
      // Typed, reportable, and the words are already safe on disk.
      const why =
        d.kind === "addon_missing"
          ? `speaker diarization unavailable: ${d.detail}`
          : d.kind === "models_missing"
            ? `speaker diarization unavailable: ${d.detail}`
            : `speaker diarization failed: ${d.detail}`;
      notes.push(`${why} — the words and timings are complete; only the speaker layer is absent`);
      log.warn("transcribe", `${opts.key}: ${why}`);
    }
  }
  if (wav) tryUnlink(wav);

  finalizeDoc(doc);

  // ── STEP 5 — THE SIDECAR AND THE SEVEN EXPORTS ─────────────────────────────────────────────────
  const sidecarPath = path.join(opts.outDir, `${opts.key}.segments.json`);
  writeFileAtomic(sidecarPath, `${JSON.stringify(doc, null, 2)}\n`);
  files.segments = sidecarPath;

  // A format whose precondition is missing is SKIPPED, not written empty. `.srt`/`.vtt`/`.ctm` need
  // timings; `.rttm` needs speakers. An empty file of the right name is worse than an absent one —
  // it looks like a successful export of a silent recording.
  const scriptOpts = { key: opts.key, title: opts.title ?? null, recordedOn: opts.recordedOn ?? null, fps: null };
  const needsTimings: ExportFormat[] = ["vtt", "srt", "ctm"];
  for (const format of EXPORT_FORMATS) {
    if (needsTimings.includes(format) && !doc.has_timings) continue;
    if (format === "ctm" && !doc.has_words) continue;
    if (format === "rttm" && !doc.has_speakers) continue;
    const body = exportAs(doc, format, scriptOpts);
    if (!body.trim()) continue;
    const target = path.join(opts.outDir, `${opts.key}${EXPORT_SUFFIX[format]}`);
    writeFileAtomic(target, body);
    files[format] = target;
  }

  if (!doc.has_timings) notes.push("no timings in this document, so .srt, .vtt and .ctm were not written");
  if (!doc.has_speakers) notes.push("no speaker layer in this document, so .rttm was not written");

  return {
    status: "ok",
    key: opts.key,
    outDir: opts.outDir,
    files,
    words,
    durationS: doc.duration_s,
    hasTimings: doc.has_timings,
    hasSpeakers: doc.has_speakers,
    speakers: doc.speakers.length,
    diarTurns,
    notes,
    reason: null,
    elapsedS: (Date.now() - started) / 1000,
  };
}

/** A human-readable status block for one result — what the CLI appends to its status file. */
export function formatRichStatus(r: RichTranscribeResult): string {
  const o: string[] = [];
  o.push(`${r.status === "ok" ? "[ DONE]" : r.status === "no_audio" ? "[NOAUD]" : "[FAIL ]"} ${r.key}`);
  if (r.reason) o.push(`    reason        ${r.reason}`);
  if (r.status === "ok") {
    o.push(`    words         ${r.words}`);
    o.push(`    audio         ${r.durationS === null ? "unknown" : `${r.durationS.toFixed(1)} s`}`);
    o.push(`    elapsed       ${r.elapsedS.toFixed(1)} s${r.durationS ? `  (${(r.elapsedS / r.durationS).toFixed(2)}x realtime)` : ""}`);
    o.push(`    timings       ${r.hasTimings ? "yes" : "NO"}`);
    o.push(`    speakers      ${r.hasSpeakers ? `${r.speakers} (${r.diarTurns} turns)` : "NO"}`);
    o.push(`    files         ${Object.keys(r.files).sort().join(", ")}`);
  }
  for (const n of r.notes) o.push(`    note          ${n}`);
  return o.join("\n");
}
