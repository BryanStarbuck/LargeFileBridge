// THE CANONICAL TIMED + ATTRIBUTED TRANSCRIPT DOCUMENT — the one thing every output format derives from.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────────
//
// Until this was written, LFB transcription produced ONE plain-text file and nothing else. The engine
// result type carried `{ status, outputPath, words, reason }` — a word COUNT, not word timings — and a
// grep across code/, cli/ and pm/ for `diariz|speaker|srt|vtt|rttm|fountain` returned nothing at all.
// So a transcript could tell you what was said and could not tell you WHEN, or BY WHOM, and could not
// be opened by any tool that expects a subtitle or a diarization file.
//
// That is the whole gap this module closes. It is modelled on the We The Citizens implementation
// (~/BGit/act3/we_citizens, packages/shared/src/schemas.ts + transcript_export.ts), which is the
// verified reference: one canonical document, then PURE SERIALIZERS over it. Adopting that shape
// rather than inventing one means the two products' transcripts can be compared field by field, and
// it is why `exporters.ts` is a set of functions with no I/O and no engine knowledge.
//
// ── THE TWO RULES THAT SHAPE EVERY FIELD BELOW ───────────────────────────────────────────────────
//
// 1. THE FLAT TEXT IS THE AUTHORITY; THIS DOCUMENT IS A SIDECAR. The `.transcription` file holds the
//    words and is what anything quoting the transcript must read. This document may be absent, may be
//    regenerated, and NOTHING may fail because it is missing. Timing and speakers are ENRICHMENTS.
//
// 2. ABSENT IS ABSENT, AND A NAMED GAP BEATS A QUIET ONE. Every "we do not know" here is a null plus a
//    typed cause, never a zero and never a guess. `start_s: 0` on an untimed segment is a false claim
//    about when something was said; `speaker: "SPEAKER_00"` on a file that was never diarized is a
//    fabricated attribution. Both render perfectly and both are lies, so neither is permitted — see
//    `speaker_cause` and the `gaps[]` array, which exist precisely so the refusal is VISIBLE.
import { createHash } from "node:crypto";

/** How the words were obtained. `mixed` covers a run whose chunks came from more than one engine. */
export type TranscriptTier = "apple_speech" | "whisper_cpp" | "whisper_py" | "qwen_mlx" | "mixed";

/**
 * What the timings are actually WORTH, as a closed vocabulary rather than a boolean. A reader deciding
 * whether to trust a seek target needs to know which of these produced it:
 *   `dtw`          — whisper.cpp DTW token alignment. The best we produce.
 *   `token_coarse` — whisper.cpp per-token offsets without DTW (DTW is disabled under flash-attn).
 *                    Accurate to a token boundary, which is what we claim and no more.
 *   `segment_only` — segment start/end are real; word timings were not produced.
 *   `cue_boundary` — timings came from a subtitle track we were handed, not from our own decode.
 *   `none`         — no timings at all. The document still renders (rule 1 above).
 */
export type WordTimingKind = "dtw" | "token_coarse" | "segment_only" | "cue_boundary" | "none";

/** Confidence bands, deliberately coarse. A rendering and confidence input, NEVER a gate. */
export type ConfBand = "high" | "low" | "none";

/** ONE WORD, with its own timing and its own confidence. `c` is null when the engine reported none. */
export interface TranscriptWord {
  /** The token text, already trimmed. Never contains whitespace — see `toCtm`, which would break. */
  w: string;
  /** Seconds from the start of the MEDIA. */
  s: number;
  e: number;
  /** 0..1 from the engine, or null. */
  c: number | null;
}

/**
 * WHY A SEGMENT MAY HAVE NO SPEAKER, as a closed vocabulary. RTTM has no way to say "we don't know",
 * so an unattributed segment is OMITTED from that export — which scores as a miss against us rather
 * than as a wrong attribution. That is the intended trade and this field is what records the reason.
 *   `no_diarization`        — the diarizer never ran (absent addon, absent models, or it was disabled).
 *   `no_turn_overlap`       — it ran, but no speaker turn covered this segment's midpoint.
 *   `diarization_failed`    — it ran and errored. The words survive; the speaker layer does not.
 */
export type SpeakerCause = "no_diarization" | "no_turn_overlap" | "diarization_failed";

export interface TranscriptSegment {
  /** Stable index within this document, from 0. */
  i: number;
  /** Seconds from the start of the MEDIA. Null on a flat document's one-segment-per-paragraph form. */
  start_s: number | null;
  end_s: number | null;
  /** A LABEL, not an identity: "SPEAKER_00", or a display name once somebody maps it. */
  speaker: string | null;
  speaker_conf: ConfBand | null;
  /** Why `speaker` is null. Set whenever `speaker` is null; omitted when it is not. */
  speaker_cause: SpeakerCause | null;
  /** Mean word confidence fell under the rendering threshold. Rendering input only. */
  low_conf: boolean;
  text: string;
  /** OMITTED (empty) when the engine produced none. Absence is normal, never an error. */
  words: TranscriptWord[];
}

/** A TYPED, POSITIONED gap. A gap is never omitted and never silently swallowed. */
export interface TranscriptGap {
  kind: "no_timings_captured" | "no_speakers_captured" | "speaker_undetermined" | "chunk_rejected";
  start_s: number | null;
  end_s: number | null;
  segment_i: number | null;
  cause: string;
}

/** ONE diarization cluster. `n` is the stable global ordinal BY FIRST SPEAKING TIME. */
export interface TranscriptSpeakerCluster {
  /** The raw diarization label, e.g. "SPEAKER_00". Joins to `TranscriptSegment.speaker`. */
  id: string;
  /**
   * The ordinal a human sees ("Speaker 1"). Assigned by first speaking time and FROZEN, so a
   * clustering-threshold change that splits a cluster cannot renumber the people who were already
   * named — the same human keeps the same number across re-runs of everything downstream.
   */
  n: number;
  /** A display label. Defaults to `Speaker ${n}`; a human or a later pass may overwrite it. */
  label: string;
  /** Total seconds attributed to this cluster, and when it first spoke. */
  speaking_s: number;
  first_s: number | null;
  /** How many turns the diarizer gave this cluster — the honest measure of how much evidence it had. */
  turns: number;
}

/** Provenance for the WORDS. A future re-run is then a COMPARISON rather than a guess. */
export interface AsrHeader {
  engine: string | null;
  model: string | null;
  version: string | null;
  /** e.g. "metal", "cpu", "mps". */
  compute: string | null;
  word_timing: WordTimingKind;
  segments: number;
}

/** Provenance for the SPEAKERS, including the one honesty flag that matters most. */
export interface DiarHeader {
  engine: string | null;
  seg_model: string | null;
  emb_model: string | null;
  turns: number;
  clusters: number;
  /**
   * FALSE MEANS "WE DID NOT LOOK". This is stated once at the top of every export that can carry a
   * note, because a reader who sees no overlap markers will otherwise conclude there was no
   * crosstalk — a much stronger claim than "our diarizer does not detect overlap".
   */
  overlap_detection: boolean;
  /** Set when the clustering was constrained to a known speaker count instead of a threshold. */
  num_clusters_forced: number | null;
  threshold: number | null;
}

/** THE DOCUMENT. Everything in `exporters.ts` is a pure function of this. */
export interface TranscriptDoc {
  schema_version: 1;
  /** A stable id for this transcript — the media's video key or a content hash. Used by RTTM/CTM. */
  canonical_id: string;
  source: TranscriptTier | null;
  language: string | null;
  has_timings: boolean;
  has_speakers: boolean;
  has_words: boolean;
  duration_s: number | null;
  produced_at: string;
  /** sha256 of the `.transcription` file's BYTES — the anchor everything else is checked against. */
  text_sha256: string | null;
  asr: AsrHeader;
  diar: DiarHeader;
  speakers: TranscriptSpeakerCluster[];
  /** label -> display name, when a human or a later pass has named somebody. */
  speaker_map: Record<string, string>;
  gaps: TranscriptGap[];
  segments: TranscriptSegment[];
}

/** An empty ASR header — every field explicitly unknown rather than defaulted to something plausible. */
export function emptyAsrHeader(): AsrHeader {
  return { engine: null, model: null, version: null, compute: null, word_timing: "none", segments: 0 };
}

/** An empty diarization header. `overlap_detection: false` is the truthful default: we did not look. */
export function emptyDiarHeader(): DiarHeader {
  return {
    engine: null,
    seg_model: null,
    emb_model: null,
    turns: 0,
    clusters: 0,
    overlap_detection: false,
    num_clusters_forced: null,
    threshold: null,
  };
}

export function emptyDoc(canonicalId: string): TranscriptDoc {
  return {
    schema_version: 1,
    canonical_id: canonicalId,
    source: null,
    language: null,
    has_timings: false,
    has_speakers: false,
    has_words: false,
    duration_s: null,
    produced_at: new Date().toISOString(),
    text_sha256: null,
    asr: emptyAsrHeader(),
    diar: emptyDiarHeader(),
    speakers: [],
    speaker_map: {},
    gaps: [],
    segments: [],
  };
}

export function sha256(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Recompute the three `has_*` booleans and the cluster roll-ups FROM the segments, then return the doc.
 *
 * These are derived facts and this is the ONLY place allowed to set them. The alternative — each
 * producer setting `has_speakers` when it thinks it added speakers — is how a document ends up
 * claiming a speaker layer it does not have: the flag renders, the exports believe it, and the
 * missing layer surfaces only when a human opens the RTTM and finds it empty. Call this once, last.
 */
export function finalizeDoc(doc: TranscriptDoc): TranscriptDoc {
  const segs = doc.segments;
  doc.has_timings = segs.some((s) => s.start_s !== null && s.end_s !== null);
  doc.has_words = segs.some((s) => s.words.length > 0);
  doc.has_speakers = segs.some((s) => s.speaker !== null);

  // Roll up per-cluster speaking time / first-speaking time / turn count from the segments that were
  // actually attributed, so `speakers[]` can never disagree with `segments[]`.
  const acc = new Map<string, { speaking_s: number; first_s: number | null; turns: number }>();
  for (const s of segs) {
    if (s.speaker === null || s.start_s === null || s.end_s === null) continue;
    const cur = acc.get(s.speaker) ?? { speaking_s: 0, first_s: null, turns: 0 };
    cur.speaking_s += Math.max(0, s.end_s - s.start_s);
    cur.first_s = cur.first_s === null ? s.start_s : Math.min(cur.first_s, s.start_s);
    cur.turns += 1;
    acc.set(s.speaker, cur);
  }

  // Ordinals by FIRST SPEAKING TIME (see TranscriptSpeakerCluster.n for why this ordering and not
  // "most talkative" or label order).
  const ids = [...acc.keys()].sort((a, b) => {
    const fa = acc.get(a)?.first_s ?? Number.POSITIVE_INFINITY;
    const fb = acc.get(b)?.first_s ?? Number.POSITIVE_INFINITY;
    return fa === fb ? a.localeCompare(b) : fa - fb;
  });
  doc.speakers = ids.map((id, idx) => {
    const a = acc.get(id)!;
    // Preserve a label somebody already set; only default the ones we are inventing.
    const existing = doc.speakers.find((s) => s.id === id);
    return {
      id,
      n: idx + 1,
      label: existing?.label && existing.label !== `Speaker ${existing.n}` ? existing.label : `Speaker ${idx + 1}`,
      speaking_s: Math.round(a.speaking_s * 1000) / 1000,
      first_s: a.first_s,
      turns: a.turns,
    };
  });
  doc.diar.clusters = doc.speakers.length;

  // The two gaps that must be STATED rather than inferred from an empty array. A reader must be able
  // to tell "this file has no speaker layer" from "this file has a speaker layer that found nobody".
  if (!doc.has_timings && !doc.gaps.some((g) => g.kind === "no_timings_captured")) {
    doc.gaps.push({
      kind: "no_timings_captured",
      start_s: null,
      end_s: null,
      segment_i: null,
      cause: "the engine produced no segment timings; the words are complete and unquotable positions are absent",
    });
  }
  if (!doc.has_speakers && !doc.gaps.some((g) => g.kind === "no_speakers_captured")) {
    const why = doc.diar.engine
      ? `diarization ran (${doc.diar.engine}) and attributed no segment`
      : "diarization did not run on this file";
    doc.gaps.push({ kind: "no_speakers_captured", start_s: null, end_s: null, segment_i: null, cause: why });
  }
  return doc;
}

/**
 * Build a document from FLAT TEXT with no timings — the degenerate form, one segment per paragraph.
 *
 * This is not a fallback nobody uses: it is what keeps the whole design honest. Every engine LFB
 * supports (Apple SpeechAnalyzer, the Python whisper CLI, qwen) can produce plain text, and only
 * whisper.cpp currently produces timings. Rather than have two rendering paths — "rich transcripts"
 * and "the other kind" — a flat transcript becomes a valid document with `has_timings: false` and a
 * stated gap, so every exporter, every reader and every UI has exactly ONE shape to handle.
 */
export function docFromFlatText(canonicalId: string, text: string, tier: TranscriptTier | null): TranscriptDoc {
  const doc = emptyDoc(canonicalId);
  doc.source = tier;
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  doc.segments = paras.map((p, i) => ({
    i,
    start_s: null,
    end_s: null,
    speaker: null,
    speaker_conf: null,
    speaker_cause: "no_diarization",
    low_conf: false,
    text: p,
    words: [],
  }));
  return finalizeDoc(doc);
}
