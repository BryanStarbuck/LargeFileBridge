// THE OUTPUT FORMATS — pure serializers over one `TranscriptDoc`. No I/O, no engine knowledge.
//
// ── WHY THE STANDARDS ARE EXPORTED RATHER THAN ADOPTED ───────────────────────────────────────────
//
// No published transcript standard carries word timing AND first-class speaker identity AND
// per-word confidence AND a typed gap vocabulary in one document. So the canonical store is the
// house schema in `segments.ts`, and the obligation to the outside world is discharged by exporting
// the real standards from it. That is the We The Citizens design (pm/transcription.mdx §22) and this
// module is a port of its `packages/shared/src/transcript_export.ts`, which is the verified
// reference implementation.
//
// PUBLISHING RTTM AND CTM IS NOT A CONSOLATION PRIZE. They are specifically what lets somebody else
// compute DER against our diarization and WER against our words. A tool that publishes a transcript
// and hides the error rate of the machine that produced it is asking to be trusted rather than
// checked, and these two files are the difference.
//
// ── THE ONE RULE THAT KEEPS THESE FILES HONEST ───────────────────────────────────────────────────
//
// A SEGMENT WITH NO TIMING IS SKIPPED, NEVER EMITTED AT SECOND ZERO. A cue at 00:00:00.000 is a
// false claim about when something was said, and it is worse than an absent cue because it renders
// perfectly. Same for speakers: an unattributed segment is omitted from RTTM rather than guessed
// into somebody's line, which scores as a MISS against us instead of a wrong attribution.
import type { TranscriptDoc, TranscriptSegment, TranscriptWord } from "./segments.js";

export type ExportFormat = "vtt" | "srt" | "rttm" | "ctm" | "jsonl" | "script" | "fountain";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["vtt", "srt", "rttm", "ctm", "jsonl", "script", "fountain"];

/** The file suffix each format is written with, beside the `.transcription`. */
export const EXPORT_SUFFIX: Record<ExportFormat, string> = {
  vtt: ".vtt",
  srt: ".srt",
  rttm: ".rttm",
  ctm: ".ctm",
  jsonl: ".segments.jsonl",
  script: ".script.txt",
  fountain: ".fountain",
};

export const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  vtt: "text/vtt; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
  rttm: "text/plain; charset=utf-8",
  ctm: "text/plain; charset=utf-8",
  jsonl: "application/jsonl; charset=utf-8",
  script: "text/plain; charset=utf-8",
  fountain: "text/vnd.fountain; charset=utf-8",
};

/** WebVTT wants `HH:MM:SS.mmm`; SRT wants the same with a comma. Both fixed-width, always. */
function stamp(seconds: number, comma = false): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}${
    comma ? "," : "."
  }${String(ms).padStart(3, "0")}`;
}

function hhmmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** SMPTE non-drop `HH:MM:SS:FF`, for a script that was given a frame rate. */
function smpte(seconds: number, fps: number): string {
  const s = Math.max(0, seconds);
  const whole = Math.floor(s);
  const frames = Math.min(Math.round(fps) - 1, Math.floor((s - whole) * fps));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  return [h, m, whole % 60, frames].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * HOW A SPEAKER RENDERS, precedence, top wins. Every exporter reuses this so a subtitle file and an
 * as-broadcast script from the same document can never disagree about who was talking.
 *   1. a `speaker_map` entry (a human, or a later pass, named this cluster);
 *   2. the cluster's own `label` ("Speaker 2");
 *   3. the raw diarization label.
 */
export function speakerNameFor(doc: TranscriptDoc, label: string | null): string | null {
  if (!label) return null;
  const mapped = doc.speaker_map[label];
  if (mapped) return mapped;
  return doc.speakers.find((s) => s.id === label)?.label || label;
}

// ── WEBVTT ────────────────────────────────────────────────────────────────────────────────────────

/**
 * WebVTT, and it is the richest of the standard formats for our purposes because it carries BOTH
 * things we need natively and by spec: `<v Speaker>` voice spans (W3C: "represents the name of the
 * voice", and CSS-selectable via `::cue(v[voice="…"])`) and INLINE CUE TIMESTAMPS (`<00:12:12.580>`),
 * which are a standardized word-level seek mechanism. That is what makes `<track kind="captions">`,
 * ffmpeg, VLC and an outsider's toolchain work with zero knowledge of our schema.
 */
export function toVtt(doc: TranscriptDoc, key: string): string {
  const out: string[] = ["WEBVTT", ""];
  out.push(`NOTE generated from ${key}.segments.json — do not edit, re-derive`);
  out.push(
    `NOTE asr=${doc.asr.engine ?? "none"}/${doc.asr.model ?? "none"} diar=${doc.diar.engine ?? "none"} word_timing=${doc.asr.word_timing}`,
  );
  // The "we did not look" statement travels with the FILE, not only with our own UI.
  if (doc.has_speakers && !doc.diar.overlap_detection) {
    out.push("NOTE overlapping speech is not detected by this diarizer");
  }
  if (!doc.has_speakers) {
    out.push("NOTE no speaker layer in this document — cues carry no voice spans");
  }
  out.push("");
  for (const s of doc.segments) {
    if (s.start_s === null || s.end_s === null) continue;
    out.push(String(s.i));
    out.push(`${stamp(s.start_s)} --> ${stamp(s.end_s)}`);
    const name = speakerNameFor(doc, s.speaker);
    out.push(`${name ? `<v ${name}>` : ""}${cueBody(s.text, s.words, s.start_s)}`);
    out.push("");
  }
  return out.join("\n");
}

/**
 * Inline cue timestamps for every word after the first.
 *
 * Monotonicity is a WebVTT REQUIREMENT, not a nicety: a player rejects an entire cue whose inline
 * timestamps go backwards. So a word whose start regressed is emitted with no timestamp at all
 * rather than with one that would invalidate the cue it sits in.
 */
function cueBody(text: string, words: TranscriptWord[], start: number): string {
  if (!words.length) return text;
  let last = start;
  const parts: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i === 0 || w.s <= last) {
      parts.push(w.w);
    } else {
      parts.push(`<${stamp(w.s)}>${w.w}`);
      last = w.s;
    }
  }
  return parts.join(" ");
}

// ── SRT ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * SubRip, the lowest common denominator. No word timing, and no speaker MECHANISM: SubRip has no
 * equivalent of WebVTT's `<v Name>`, so the only way to say who was talking is the `Name: ` prefix
 * convention inside the cue text.
 *
 * That prefix is therefore OPT-IN. It is on for the copy written to disk beside the words, because a
 * caption file somebody opens in VLC is the one place the attribution is worth spending a
 * non-standard convention on. A document with no speakers gets no prefixes either way — an absent
 * attribution is a refusal, never a guess.
 */
export function toSrt(doc: TranscriptDoc, opts: { speakers?: boolean } = {}): string {
  const out: string[] = [];
  let n = 1;
  for (const s of doc.segments) {
    if (s.start_s === null || s.end_s === null) continue;
    out.push(String(n++));
    out.push(`${stamp(s.start_s, true)} --> ${stamp(s.end_s, true)}`);
    const name = opts.speakers ? speakerNameFor(doc, s.speaker) : null;
    out.push(name ? `${name}: ${s.text}` : s.text);
    out.push("");
  }
  return out.join("\n");
}

// ── THE FLAT WORDS ────────────────────────────────────────────────────────────────────────────────

/**
 * `{key}.transcription` — THE AUTHORITY FOR THE WORDS, derived from the same document as everything
 * else so the corpus and the captions can never drift apart.
 *
 * Speakers are NOT prefixed here, unlike the `.srt`. This file is the corpus that gets QUOTED, and a
 * `Name: ` prefix would become part of a quoted sentence and assert an attribution inside the
 * evidence. Speaker identity travels in the sidecar, the `.vtt`, the `.rttm` and the script.
 *
 * Returns "" for a document with no usable text; the caller writes nothing and states the gap rather
 * than committing an empty file that claims a file was transcribed when it was not.
 */
export function toFlatTranscript(doc: TranscriptDoc): string {
  const words = deoverlapCues(doc.segments.map((s) => (s.text ?? "").replace(/\s+/g, " ").trim()));
  return words.length ? `${paragraphize(words).join("\n\n")}\n` : "";
}

/**
 * ROLLING CAPTIONS — the thing that makes the flat transcript more than a `join("\n\n")`.
 *
 * A scrolling caption track is not a list of disjoint cues; each cue repeats the tail of the one
 * before it and then adds a few words:
 *
 *     cue 1  "We have seen how low the president's"
 *     cue 2  "We have seen how low the president's approval is on Iran. But"
 *     cue 3  "approval is on Iran. But"
 *
 * Concatenating those yields every sentence two or three times. That is not cosmetic: the flat file
 * is what gets quoted, so a naive join puts a stuttering, tripled sentence into published evidence
 * and inflates any word count taken from it by 2–3×. In the We The Citizens corpus this was measured
 * at 802 of 941 sidecars affected, and fixing the seam took a word count from 2.73 M to 0.96 M.
 *
 * The fix is general rather than a per-source special case: append only the part of each cue that is
 * not already the tail of what we have written. Overlap is matched on WORDS, not characters, so a
 * cue resuming mid-sentence cannot glue two half-words together. A cue with no overlap contributes
 * all of itself, so a non-rolling source keeps every word in the same order.
 *
 * WHAT IT DOES NOT DO: it does not repair the source. A doubled word inside ONE cue survives
 * verbatim — the seam between cues is ours to fix, the words inside one are not ours to edit.
 */
function deoverlapCues(cues: string[]): string[] {
  const out: string[] = [];
  for (const cue of cues) {
    if (!cue) continue;
    const words = cue.split(" ").filter(Boolean);
    // The longest tail of what we have that is also the head of this cue. Bounded by the cue's own
    // length — a caption line — so this stays a few dozen comparisons and never scans the corpus.
    let k = Math.min(out.length, words.length);
    while (k > 0 && !sameWords(out, out.length - k, words, k)) k--;
    for (let i = k; i < words.length; i++) out.push(words[i]);
  }
  return out;
}

/** Case-insensitive word-run equality — a caption track re-capitalizes the first word of a cue, and
 *  a case difference there is a rendering artifact, never a different word. */
function sameWords(a: string[], aStart: number, b: string[], n: number): boolean {
  for (let i = 0; i < n; i++) if (a[aStart + i].toLowerCase() !== b[i].toLowerCase()) return false;
  return true;
}

/** Break the de-overlapped word stream into ~350-character paragraphs at SENTENCE ENDS. Never
 *  mid-clause: a paragraph break inside a sentence would show up inside a quotation. */
function paragraphize(words: string[]): string[] {
  const paragraphs: string[] = [];
  let buf: string[] = [];
  let len = 0;
  for (const w of words) {
    buf.push(w);
    len += w.length + 1;
    if (len >= 350 && /[.!?]["')\]]?$/.test(w)) {
      paragraphs.push(buf.join(" "));
      buf = [];
      len = 0;
    }
  }
  if (buf.length) paragraphs.push(buf.join(" "));
  return paragraphs;
}

/** Word count on the SAME bytes the file holds, so an index and the file can never disagree. */
export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

// ── NIST RTTM / CTM — THE TWO AUDIT FORMATS ───────────────────────────────────────────────────────

/**
 * NIST RTTM. `SPEAKER` lines for turns, and THE format every DER tool consumes (pyannote, NeMo,
 * `dscore`, Kaldi) — so anyone can evaluate our diarization against our published claims.
 *
 * Consecutive segments carrying the same label are merged into ONE turn, because a turn is what RTTM
 * means; emitting a line per ASR segment would overstate the number of speaker changes, which is
 * exactly the statistic a DER tool measures.
 */
export function toRttm(doc: TranscriptDoc): string {
  const id = doc.canonical_id || "transcript";
  const lines: string[] = [];
  let open: { label: string; start: number; end: number } | null = null;
  const flush = (): void => {
    if (!open) return;
    const dur = Math.max(0, open.end - open.start);
    if (dur > 0) {
      lines.push(`SPEAKER ${id} 1 ${open.start.toFixed(3)} ${dur.toFixed(3)} <NA> <NA> ${open.label} <NA> <NA>`);
    }
    open = null;
  };
  for (const s of doc.segments) {
    // An unattributed segment is a REFUSAL, and RTTM cannot say "we don't know" — so it is omitted,
    // which scores as a miss against us rather than as a wrong attribution.
    if (s.speaker === null || s.start_s === null || s.end_s === null) {
      flush();
      continue;
    }
    if (open && open.label === s.speaker && s.start_s <= open.end + 0.5) {
      open.end = Math.max(open.end, s.end_s);
      continue;
    }
    flush();
    open = { label: s.speaker, start: s.start_s, end: s.end_s };
  }
  flush();
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * NIST CTM: `file chan start dur word conf`, sorted by start. The standard word-timing exchange
 * format and the input to `sclite` for WER — so an outsider can measure our words against theirs.
 */
export function toCtm(doc: TranscriptDoc): string {
  const id = doc.canonical_id || "transcript";
  const rows: { s: number; line: string }[] = [];
  for (const seg of doc.segments) {
    for (const w of seg.words) {
      const dur = Math.max(0, w.e - w.s);
      // CTM is whitespace-delimited, so a token containing whitespace would silently become two
      // columns and shift every field after it. Collapsing it is the honest fix.
      const token = w.w.replace(/\s+/g, "_");
      const conf = w.c === null ? "1.00" : w.c.toFixed(2);
      rows.push({ s: w.s, line: `${id} 1 ${w.s.toFixed(3)} ${dur.toFixed(3)} ${token} ${conf}` });
    }
  }
  rows.sort((a, b) => a.s - b.s);
  return rows.length ? `${rows.map((r) => r.line).join("\n")}\n` : "";
}

// ── JSONL ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The line-oriented form: one JSON object per segment, for inspection and for `jq`. `words[]` is
 * dropped and the omission is DECLARED on the header line rather than left silent, so a reader can
 * tell "this file has no word timings" from "this copy does not carry them".
 */
export function toJsonl(doc: TranscriptDoc): string {
  const head = {
    kind: "header",
    canonical_id: doc.canonical_id,
    schema_version: doc.schema_version,
    source: doc.source,
    language: doc.language,
    duration_s: doc.duration_s,
    produced_at: doc.produced_at,
    text_sha256: doc.text_sha256,
    has_timings: doc.has_timings,
    has_speakers: doc.has_speakers,
    has_words: doc.has_words,
    words_omitted: doc.has_words,
    asr: doc.asr,
    diar: doc.diar,
    speakers: doc.speakers,
    speaker_map: doc.speaker_map,
    gaps: doc.gaps,
  };
  const lines = [JSON.stringify(head)];
  for (const s of doc.segments) {
    const { words: _words, ...rest } = s;
    lines.push(JSON.stringify({ kind: "segment", ...rest }));
  }
  return `${lines.join("\n")}\n`;
}

// ── THE TWO SCRIPT FORMATS ────────────────────────────────────────────────────────────────────────

export interface ScriptExportOptions {
  key: string;
  /** SMPTE frame rate. Null renders wall-clock stamps AND the header says so. */
  fps?: number | null;
  title?: string | null;
  /** ISO date the media was RECORDED, when an index knows it. NEVER inferred from the decode date. */
  recordedOn?: string | null;
}

function scriptStamp(seconds: number, fps: number | null): string {
  return fps && fps > 0 ? smpte(seconds, fps) : stamp(seconds);
}

/** UPPER CASE is the script convention for a character cue. */
function cueName(doc: TranscriptDoc, label: string | null): string {
  const name = speakerNameFor(doc, label);
  // A refusal, spelled so a reader cannot mistake it for somebody's name.
  if (!name) return "UNIDENTIFIED SPEAKER";
  return name.replace(/_/g, " ").toUpperCase();
}

/**
 * TURNS, not cues. `toSrt` emits one cue per raw segment because a subtitle file must match the
 * track it came from; a SCRIPT is the opposite job — consecutive segments by the same speaker are
 * one block of dialogue, and splitting them would misrepresent how many times the floor changed
 * hands.
 */
interface ScriptTurn {
  speaker: string | null;
  start_s: number | null;
  end_s: number | null;
  texts: string[];
  lowConf: boolean;
  untimed: boolean;
}

function turnsOf(doc: TranscriptDoc): ScriptTurn[] {
  const turns: ScriptTurn[] = [];
  for (const s of doc.segments) {
    const text = (s.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    // A gap of more than 15 s between two stretches by the same voice is a NEW turn even though the
    // label did not change — something happened in between (a cut, a break), and a script that
    // welded them together would assert continuous speech that did not occur.
    const contiguous =
      last !== undefined &&
      last.speaker === s.speaker &&
      (last.end_s === null || s.start_s === null || s.start_s - last.end_s <= 15);
    if (contiguous && last) {
      last.texts.push(text);
      last.end_s = s.end_s ?? last.end_s;
      last.lowConf = last.lowConf || s.low_conf;
      last.untimed = last.untimed || s.start_s === null;
      continue;
    }
    turns.push({
      speaker: s.speaker,
      start_s: s.start_s,
      end_s: s.end_s,
      texts: [text],
      lowConf: s.low_conf,
      untimed: s.start_s === null,
    });
  }
  return turns;
}

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + w.length + 1 > width) {
      lines.push(indent + cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(indent + cur);
  return lines;
}

/**
 * THE AS-BROADCAST SCRIPT. Header, cast, annotation key, then timecoded attributed turns.
 *
 * Every claim in the header is READ OFF the document rather than asserted: if diarization did not
 * run, the cast list says so and every cue reads UNIDENTIFIED SPEAKER; if no frame rate was
 * supplied, the timecode line says the stamps are wall clock. Typed gaps are rendered IN POSITION,
 * because a gap the reader cannot see is a gap the reader reads straight through.
 */
export function toScript(doc: TranscriptDoc, opts: ScriptExportOptions): string {
  const fps = opts.fps ?? null;
  const W = 80;
  const RULE = "=".repeat(W);
  const o: string[] = [];
  const turns = turnsOf(doc);
  const field = (k: string, v: string): void => {
    o.push(`${k.padEnd(16)}${v}`);
  };

  o.push(RULE, "AS-BROADCAST SCRIPT", RULE);
  field("PRODUCTION", opts.title || doc.canonical_id || opts.key);
  field("CANONICAL ID", doc.canonical_id || opts.key);
  field("RECORDED", opts.recordedOn || "not recorded in the index — not inferred");
  field("TRANSCRIBED", doc.produced_at || "unknown");
  field("RUNTIME", doc.duration_s === null ? "unknown" : `${hhmmss(doc.duration_s)}  (${doc.duration_s.toFixed(3)} s)`);
  field(
    "TIMECODE",
    fps && fps > 0
      ? `SMPTE ${fps.toFixed(3).replace(/\.?0+$/, "")} fps non-drop · 00:00:00:00 = first frame of media`
      : "HH:MM:SS.mmm wall clock from start of media (no frame rate supplied)",
  );
  field("LANGUAGE", doc.language || "undeclared");
  field("SOURCE TIER", doc.source || "unknown");
  field("ASR", `${doc.asr.engine ?? "none"} / ${doc.asr.model ?? "none"}${doc.asr.compute ? ` (${doc.asr.compute})` : ""}`);
  field(
    "DIARIZATION",
    doc.diar.engine
      ? `${doc.diar.engine}${doc.diar.seg_model ? ` / ${doc.diar.seg_model}` : ""} · ${doc.diar.clusters} clusters · ${doc.diar.turns} turns`
      : "none — every cue reads UNIDENTIFIED SPEAKER",
  );
  field("OVERLAP DETECT", doc.diar.overlap_detection ? "yes" : "no — absence of an (OVERLAP) mark means WE DID NOT LOOK");
  field("WORD TIMINGS", doc.has_words ? `yes (${doc.asr.word_timing})` : `no (${doc.asr.word_timing})`);
  field("TEXT SHA256", doc.text_sha256 || "unset");
  o.push("", `DERIVED FROM ${opts.key}.segments.json — DO NOT EDIT. Re-derive instead.`);

  o.push("", "-".repeat(W), "CAST", "-".repeat(W));
  if (!doc.speakers.length) {
    o.push("  no diarization clusters in this document — attribution is unavailable");
  } else {
    // Speaking share is computed from the turns actually rendered, so the number describes THIS file.
    const total = turns.reduce((a, t) => a + Math.max(0, (t.end_s ?? 0) - (t.start_s ?? 0)), 0);
    for (const sp of doc.speakers) {
      const mine = turns.filter((t) => t.speaker === sp.id);
      const secs = mine.reduce((a, t) => a + Math.max(0, (t.end_s ?? 0) - (t.start_s ?? 0)), 0);
      const share = total > 0 ? `${((secs / total) * 100).toFixed(1)}%` : "—";
      const identity = doc.speaker_map[sp.id] ? `${doc.speaker_map[sp.id]} (NAMED)` : "unnamed — a label, not an identity";
      // Truncated rather than allowed to overrun: a label wider than its column shunts every
      // following field right and the cast list stops being a table.
      o.push(
        `  ${sp.id.padEnd(12)}${(sp.label || "unlabelled").slice(0, 29).padEnd(30)}${share.padStart(6)} of speech · ${String(mine.length).padStart(4)} turns`,
      );
      o.push(`  ${" ".repeat(12)}identity: ${identity}`);
    }
  }

  o.push("", "-".repeat(W), "ANNOTATION KEY", "-".repeat(W));
  o.push("  (LOW CONFIDENCE)   mean word confidence fell below the rendering threshold");
  o.push("  (UNTIMED)          the words are on the record but carry no seek target");
  o.push("  UNIDENTIFIED       diarization returned no speaker for this turn — a refusal, not a guess");
  o.push("  >> GAP: kind <<    a typed, positioned gap in the record, rendered where it occurred");
  o.push("", RULE, "");

  // Gaps are interleaved by start time so the reader meets them where they happened.
  const gapQueue = [...doc.gaps].filter((g) => g.start_s !== null).sort((a, b) => (a.start_s ?? 0) - (b.start_s ?? 0));
  const untimedGaps = doc.gaps.filter((g) => g.start_s === null);
  let gi = 0;

  for (const t of turns) {
    while (gi < gapQueue.length && (gapQueue[gi].start_s ?? 0) <= (t.start_s ?? Number.POSITIVE_INFINITY)) {
      const g = gapQueue[gi++];
      o.push(`${scriptStamp(g.start_s ?? 0, fps).padEnd(14)}>> GAP: ${g.kind}${g.cause ? ` — ${g.cause}` : ""} <<`, "");
    }
    const marks: string[] = [];
    if (t.lowConf) marks.push("(LOW CONFIDENCE)");
    if (t.untimed) marks.push("(UNTIMED)");
    const tc = t.start_s === null ? "--:--:--.---" : scriptStamp(t.start_s, fps);
    o.push(`${tc.padEnd(14)}${cueName(doc, t.speaker)}${marks.length ? `   ${marks.join(" ")}` : ""}`);
    o.push(...wrap(t.texts.join(" "), W - 14, " ".repeat(14)));
    o.push("");
  }
  for (const g of untimedGaps) {
    o.push(`${"".padEnd(14)}>> GAP: ${g.kind}${g.cause ? ` — ${g.cause}` : ""} <<`, "");
  }

  o.push(
    RULE,
    `END OF SCRIPT · ${turns.length} turns · ${countWords(turns.map((t) => t.texts.join(" ")).join(" "))} words`,
    RULE,
    "",
  );
  return o.join("\n");
}

/**
 * FOUNTAIN (fountain.io), the open plain-text screenplay standard.
 *
 * Title page keys, a scene heading, then CHARACTER / dialogue pairs. Timecode travels as a Fountain
 * NOTE (`[[…]]`) rather than as action, because a note is the one element every Fountain reader
 * agrees to carry and NOT to typeset as dialogue — so the script paginates correctly while the
 * timing survives the round trip.
 */
export function toFountain(doc: TranscriptDoc, opts: ScriptExportOptions): string {
  const fps = opts.fps ?? null;
  const o: string[] = [];
  const turns = turnsOf(doc);

  o.push(`Title: ${opts.title || doc.canonical_id || opts.key}`);
  o.push("Credit: transcribed by");
  o.push("Author: Large File Bridge — automated transcription");
  o.push(`Source: ${doc.source ?? "unknown"} · ${doc.asr.engine ?? "none"}/${doc.asr.model ?? "none"}`);
  if (opts.recordedOn) o.push(`Recorded: ${opts.recordedOn}`);
  o.push(`Draft date: ${(doc.produced_at || "").slice(0, 10) || "unknown"}`);
  o.push(
    `Notes: diarization=${doc.diar.engine ?? "none"}; word_timing=${doc.asr.word_timing}; derived from ${opts.key}.segments.json — do not edit`,
  );
  o.push("", "===", "");
  o.push(".TRANSCRIPT", "");
  o.push(
    `[[Timecode is ${fps && fps > 0 ? `SMPTE ${fps.toFixed(3).replace(/\.?0+$/, "")} fps non-drop` : "wall clock HH:MM:SS.mmm"} from the first frame of media.${
      doc.diar.overlap_detection ? "" : " Overlap detection did not run: the absence of an OVERLAP note means we did not look."
    }]]`,
    "",
  );

  for (const t of turns) {
    const marks: string[] = [t.start_s !== null ? scriptStamp(t.start_s, fps) : "no timecode"];
    if (t.lowConf) marks.push("LOW CONFIDENCE");
    o.push(`[[${marks.join(" · ")}]]`);
    // A Fountain character cue must be UPPER CASE and followed directly by the dialogue line.
    o.push(cueName(doc, t.speaker));
    o.push(t.texts.join(" "));
    o.push("");
  }
  return o.join("\n");
}

/** One entry point, so a caller can loop over `EXPORT_FORMATS` without a switch of its own. */
export function exportAs(doc: TranscriptDoc, format: ExportFormat, opts: ScriptExportOptions): string {
  switch (format) {
    case "vtt":
      return toVtt(doc, opts.key);
    case "srt":
      // Speaker prefixes ON for the written copy — see `toSrt`.
      return toSrt(doc, { speakers: true });
    case "rttm":
      return toRttm(doc);
    case "ctm":
      return toCtm(doc);
    case "jsonl":
      return toJsonl(doc);
    case "script":
      return toScript(doc, opts);
    case "fountain":
      return toFountain(doc, opts);
  }
}

/** Which segment a diarization turn belongs to, for the merge in `rich.ts`. Exported for its test. */
export function midpoint(s: TranscriptSegment): number | null {
  if (s.start_s === null || s.end_s === null) return null;
  return s.start_s + (s.end_s - s.start_s) / 2;
}
