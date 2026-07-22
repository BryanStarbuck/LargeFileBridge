// MPEG-7 Video Signature via the bundled ffmpeg `signature` filter (subsets.mdx §7 — the LOCKED primary
// containment matcher). The ISO/IEC 15938-3 standard built precisely for "is this sequence contained in
// that one, and WHERE": fine per-frame signatures plus coarse ~90-frame segment signatures, resistant to
// lossy re-encode, resolution and codec change. Zero new dependencies — the same ffmpeg every other
// engine shells out to by name on PATH; fully local, no network (charter).
//
//   • computeSignature(path, sha256) — export the per-video signature once, cached at
//     `<state root>/videos/signatures/<sha256>.mpeg7sig` (binary; keyed by CONTENT hash so a re-encode
//     gets a fresh signature — subsets.mdx §7.4). `ffmpeg -i <video> -vf signature=format=binary:
//     filename=<out> -f null -`.
//   • findContainment(subsetPath, supersetPath, subsetDurationS) — the two-input detect
//     (`signature=nb_inputs=2:detectmode=full`), whose match report is parsed off the ffmpeg log into
//     { startS, endS, confidence } in SUPERSET time.
//
// CLI REALITY NOTE (deviation from subsets.mdx §7.5, recorded here on purpose): ffmpeg's signature
// filter cannot LOAD two stored .mpeg7sig files for comparison — its detect mode recomputes signatures
// from the two video inputs. So the pair lookup re-decodes media; only the vPDQ cross-check
// (vpdq.service.ts) truly compares stored values. The cached .mpeg7sig files still satisfy the storage
// contract (a durable, referenceable fingerprint artifact per video) and would plug straight into a
// future signature-file comparator.
//
// THE LOG FORMAT the parser understands (ffmpeg libavfilter/vf_signature.c, lookup_signatures()):
//
//   [Parsed_signature_0 @ 0x...] matching of video 0 at 3.400000 and 1 at 190.000000, 5462 frames matching
//   [Parsed_signature_0 @ 0x...] whole video matching
//
// — "video <i> at <seconds>" names where the match STARTS in each input (the filter reports at its
// internal 30 fps grid: index/30 seconds), and "<n> frames matching" is the matched span at that same
// 30 fps. `detectmode=full` keeps checking to the end and appends "whole video matching" when one input
// is entirely contained. The parser is deliberately TOLERANT (unit-tested against a canned log): it
// scans any line containing the phrase, accepts integer or decimal seconds, ignores prefixes, and
// never throws on junk.
import fs from "node:fs";
import path from "node:path";
import { runAsync, toolOnPath } from "./exec.js";
import { signaturesDir } from "./paths.js";
import { log } from "../../shared/logging.js";

/** The signature filter reports offsets/spans on its internal 30 fps grid (index/30 seconds). */
const SIGNATURE_FPS = 30;

/** The relative reference stored in the subsets.csv `fingerprint` column (subsets.mdx §9). */
export function signatureRelRef(sha256: string): string {
  return `signatures/${sha256}.mpeg7sig`;
}

export function signatureAbsPath(sha256: string): string {
  return path.join(signaturesDir(), `${sha256}.mpeg7sig`);
}

export function hasSignature(sha256: string): boolean {
  try {
    return fs.statSync(signatureAbsPath(sha256)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Export a video's MPEG-7 signature to the sha256-keyed cache (subsets.mdx §7.3). Cached — recomputed
 * only when the content hash has no signature file yet (§7.6). Returns the absolute signature path.
 */
export async function computeSignature(abs: string, sha256: string): Promise<string> {
  const out = signatureAbsPath(sha256);
  if (hasSignature(sha256)) return out;
  if (!toolOnPath("ffmpeg")) throw new Error("ffmpeg not installed — install it (brew install ffmpeg) to compute video signatures");
  // Write to a temp name, rename on success — the cache must never hold a half-written signature.
  const tmp = `${out}.${process.pid}.tmp`;
  const r = await runAsync(
    "ffmpeg",
    ["-nostdin", "-loglevel", "error", "-i", abs, "-map", "0:v:0", "-an", "-vf", `signature=format=binary:filename=${tmp}`, "-f", "null", "-"],
    `mpeg7-sig:${abs}`,
    { timeoutMs: 20 * 60 * 1000 },
  );
  if (r.code !== 0 || !fs.existsSync(tmp)) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new Error(`ffmpeg signature export failed (code ${r.code}): ${r.stderr.slice(-300)}`);
  }
  fs.renameSync(tmp, out);
  return out;
}

/** One match the detect log reported: where the match starts in each input and its span in frames. */
export interface SignatureMatch {
  firstIndex: number; // input index the first "video <i>" names
  firstS: number; // start of the match in that input, seconds
  secondIndex: number;
  secondS: number;
  frames: number; // matched span at the filter's 30 fps grid
  whole: boolean; // "whole video matching" followed this match
}

/**
 * Parse the signature filter's match report out of an ffmpeg log (stderr). Tolerant by design: scans
 * every line, requires only the stable phrase shape, never throws. Exported for the unit test.
 */
export function parseSignatureDetectLog(logText: string): SignatureMatch[] {
  const out: SignatureMatch[] = [];
  const re = /matching of video\s+(\d+)\s+at\s+([0-9]+(?:\.[0-9]+)?)\s+and\s+(\d+)\s+at\s+([0-9]+(?:\.[0-9]+)?)\s*,\s*(\d+)\s+frames matching/;
  const lines = logText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    // "whole video matching" is logged on its own line directly after the match it qualifies.
    const whole = /whole video matching/.test(lines[i + 1] ?? "");
    out.push({
      firstIndex: Number(m[1]),
      firstS: Number(m[2]),
      secondIndex: Number(m[3]),
      secondS: Number(m[4]),
      frames: Number(m[5]),
      whole,
    });
  }
  return out;
}

export interface Containment {
  startS: number; // where the subset's content begins in SUPERSET time
  endS: number; // where it ends in superset time
  confidence: number; // 0..1 — matched span over the subset's duration (1 when reported whole)
}

/** Is the ffmpeg on PATH built with the signature filter? Cached for the process lifetime. */
let signatureFilterAvailable: boolean | null = null;
export async function mpeg7Available(): Promise<boolean> {
  if (signatureFilterAvailable !== null) return signatureFilterAvailable;
  if (!toolOnPath("ffmpeg")) return (signatureFilterAvailable = false);
  const r = await runAsync("ffmpeg", ["-hide_banner", "-filters"], "mpeg7-filters", {
    timeoutMs: 30_000,
    captureStdout: true,
  });
  signatureFilterAvailable = r.code === 0 && /\bsignature\b/.test(r.stdout);
  return signatureFilterAvailable;
}

/**
 * The two-input containment lookup (subsets.mdx §7.3): does `subsetPath`'s sequence appear inside
 * `supersetPath`, and where? Runs `signature=nb_inputs=2:detectmode=full` over the pair and parses the
 * reported match ranges. Returns null for "no containment found" (an answer, not an error); throws only
 * when ffmpeg itself fails to run.
 */
export async function findContainment(
  subsetPath: string,
  supersetPath: string,
  subsetDurationS: number | null,
): Promise<Containment | null> {
  // detect logs arrive at AV_LOG_INFO — `-loglevel info` is load-bearing, not chatty for its own sake.
  const r = await runAsync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "info",
      "-i", subsetPath, "-i", supersetPath,
      "-filter_complex", "[0:v][1:v]signature=nb_inputs=2:detectmode=full[sig]",
      "-map", "[sig]", "-f", "null", "-",
    ],
    `mpeg7-detect:${path.basename(subsetPath)}⊂${path.basename(supersetPath)}`,
    { timeoutMs: 30 * 60 * 1000 },
  );
  if (r.code !== 0) {
    throw new Error(`ffmpeg signature detect failed (code ${r.code}): ${r.stderr.slice(-300)}`);
  }
  const matches = parseSignatureDetectLog(r.stderr);
  if (matches.length === 0) return null;
  // Longest reported match wins. Input 0 is the subset, input 1 the superset — normalize either order.
  const best = matches.reduce((a, b) => (b.frames > a.frames ? b : a));
  const supStart = best.firstIndex === 1 ? best.firstS : best.secondS;
  const matchedS = best.frames / SIGNATURE_FPS;
  const endS = subsetDurationS !== null ? supStart + Math.min(matchedS, subsetDurationS) : supStart + matchedS;
  const confidence = best.whole
    ? 1
    : subsetDurationS && subsetDurationS > 0
      ? Math.max(0, Math.min(1, matchedS / subsetDurationS))
      : 0.5;
  log.debug(
    "videos",
    `mpeg7 containment: ${subsetPath} in ${supersetPath} at ${supStart.toFixed(1)}s for ${matchedS.toFixed(1)}s (conf ${confidence.toFixed(2)})`,
  );
  return { startS: supStart, endS, confidence };
}
