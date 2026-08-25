// THE CHARTER'S LEARNED COMPRESSION BASELINE — the first implementation of it that has ever existed.
//
// CLAUDE.md ("Detecting whether a file is 'compressed' (learned baselines)") asks for exactly this:
//
//     "Keep a … file in the repo that we train over time. It records, for a file of a given DURATION and
//      PIXEL SIZE (resolution), the typical file size when uncompressed vs. the typical file size when
//      compressed. Store the shape of the distribution, not just a point: the MEAN of the bell curve plus
//      ONE SIGMA and TWO SIGMA bounds."
//
// Until this slice the product answered "is this compressed?" from the file EXTENSION alone
// (`badges.ts compressBadge`, whose `_sizeBytes` and `_threshold` parameters were both unused — the seam
// the code had already marked for this). The extension answer is right about format and blind about
// content: a 4K screen recording exported at 60 Mbps is `.mp4` and is nowhere near compressed, and a
// carefully-tuned 720p clip is the same `.mp4` and is finished.
//
// ── THE MODEL, AND WHY IT IS THIS ONE ───────────────────────────────────────────────────────────────────
//
// NORMALIZED ON BITS PER PIXEL PER SECOND. A raw byte count cannot generalise: a 30-second 720p clip and a
// two-hour 4K film have nothing to say to each other in bytes. `bpps = size_bytes * 8 / (w * h * duration)`
// makes them commensurable, which is what lets ONE curve cover the charter's whole "range of durations and
// range of pixel sizes" grid instead of needing a sample in every cell. For an image `duration` is 1 second
// by definition (the GENERATED column COALESCEs it), so `bpps` degenerates to bits per pixel — the natural
// measure there too.
//
// LOG-NORMAL, because file sizes are. The distribution of `bpps` is right-skewed and strictly positive;
// `ln(bpps)` is the thing that is approximately normal, so the mean and the sigmas the charter asks for are
// computed on the LOG. `mu`, `mu ± sigma` and `mu ± 2*sigma` are exponentiated back to real bpps for
// display (`baselineCell`) — that is the bell curve the charter describes, reported in the units a person
// can read.
//
// ── THE ABSTENTION RULE, WHICH IS THE POINT ─────────────────────────────────────────────────────────────
//
//     A CELL WITH FEWER THAN 12 SAMPLES ANSWERS 'unknown', AND THE EXTENSION HEURISTIC STAYS IN CHARGE.
//
// This is NOT a degraded mode and NOT a failure. A wrong "uncompressed" badge is how a user is talked into
// a needless lossy generation on a file that was already finished — and the charter is absolute that we
// never compress or alter a file unless the user explicitly asks, which makes the ADVICE the thing that has
// to be trustworthy. Seeding from the 74 compression records this machine holds produces on the order of 55
// distinct samples, so most cells are below the floor and will stay there for months (database.mdx §8.7).
// Answering "unknown" honestly in that state is the design working.
//
// ── LOCAL ONLY ──────────────────────────────────────────────────────────────────────────────────────────
// Every sample is derived from the user's own files, on this computer. Nothing here reaches the network,
// and nothing here is a reporting service — the same hard requirement the charter states for the
// perceptual-fingerprint feature applies to the baseline for the same reason.
import { q, q1 } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";

/** The charter's confidence floor. Below this many samples in a cell, the verdict is `unknown`. */
export const MIN_CELL_SAMPLES = 12;

/**
 * How far a sample may sit from a hypothesis's mean and still be called that hypothesis, in sigmas.
 *
 * 2σ is the charter's own outer bound ("one sigma and two sigma"), so a file beyond 2σ of BOTH hypotheses
 * is not described by either curve and gets `unknown` rather than the nearer of two bad fits.
 */
export const MAX_Z = 2;

export type CompressionVerdict = "compressed" | "uncompressed" | "unknown";

/** What we must know about a file to ask the baseline about it. Dimensions are NOT optional: without them
 *  there is no bpps, and without bpps there is no question this model can answer. */
export interface MediaShape {
  media: "video" | "image";
  width: number;
  height: number;
  /** Seconds. Null for a still image — the model treats that as 1 second, matching the stored column. */
  durationS: number | null;
  sizeBytes: number;
}

/** One hypothesis's fitted curve, in the charter's own vocabulary. Sizes are bpps, not bytes. */
export interface BaselineCurve {
  n: number;
  /** The mean of the bell curve, in bpps (exp of the mean of ln(bpps)). */
  mean: number;
  /** mean ± 1σ, in bpps. */
  sigma1: [number, number];
  /** mean ± 2σ, in bpps. */
  sigma2: [number, number];
  /** The fit in log space, which is where the z-score is computed. */
  muLog: number;
  sigmaLog: number;
}

export interface BaselineAnswer {
  verdict: CompressionVerdict;
  /** Why the answer is what it is — surfaced so "unknown" reads as an honest abstention, not a failure. */
  reason: string;
  bpps: number | null;
  compressed: BaselineCurve | null;
  uncompressed: BaselineCurve | null;
}

/** `bpps` computed the SAME way the stored GENERATED column computes it, so a live question and a stored
 *  sample can never disagree by a rounding rule (0010 `compression_sample.bpps`). */
export function bppsFor(shape: MediaShape): number {
  const pixels = Math.max(shape.width * shape.height * (shape.durationS ?? 1), 1);
  return (shape.sizeBytes * 8) / pixels;
}

/** The cell coordinates, computed the SAME way the stored GENERATED columns compute them. */
export function cellFor(shape: MediaShape): { pixelBucket: number; durationBucket: number } {
  return {
    pixelBucket: Math.floor(Math.log2(Math.max(shape.width * shape.height, 1))),
    durationBucket: Math.floor(Math.log2(Math.max(shape.durationS ?? 1, 1))),
  };
}

interface CellRow {
  is_compressed: boolean;
  n: string;
  mu: string | null;
  sigma: string | null;
}

function toCurve(row: CellRow): BaselineCurve | null {
  const n = Number(row.n);
  const mu = row.mu === null ? NaN : Number(row.mu);
  if (!Number.isFinite(mu)) return null;
  // `stddev_samp` is NULL for n = 1. A single sample has a location and no width; treating that as sigma = 0
  // would make every z-score infinite and the classifier maximally confident from one observation. It stays
  // NaN here and the caller's `n >= MIN_CELL_SAMPLES` gate rejects it long before that could matter.
  const sigma = row.sigma === null ? NaN : Number(row.sigma);
  return {
    n,
    mean: Math.exp(mu),
    sigma1: [Math.exp(mu - sigma), Math.exp(mu + sigma)],
    sigma2: [Math.exp(mu - 2 * sigma), Math.exp(mu + 2 * sigma)],
    muLog: mu,
    sigmaLog: sigma,
  };
}

/**
 * Fit both hypotheses for the cell this file falls in, widened by ±1 bucket on each axis.
 *
 * THE ±1 WIDENING IS WHY `compression_sample_cell` HAS THE COLUMN ORDER IT HAS (0010): `media` is an
 * equality, the two buckets are RANGES, and `is_compressed` is the GROUP BY. Widening is what makes a
 * sparse grid usable at all — a 1080p 3-minute clip is described perfectly well by 720p and 4K samples of
 * similar length, because bpps already removed the resolution.
 *
 * The `HAVING count(*) >= $n` is the abstention rule expressed in SQL: a cell below the floor does not come
 * back at all, so there is no way for a caller to accidentally use one.
 */
export async function fitCell(shape: MediaShape, minSamples = MIN_CELL_SAMPLES): Promise<{
  compressed: BaselineCurve | null;
  uncompressed: BaselineCurve | null;
}> {
  const { pixelBucket, durationBucket } = cellFor(shape);
  const rows = await q<CellRow>(
    `SELECT is_compressed,
            count(*)::text            AS n,
            avg(ln(bpps))::text       AS mu,
            stddev_samp(ln(bpps))::text AS sigma
       FROM ${S}.compression_sample
      WHERE media = $1::${S}.media_kind
        AND pixel_bucket    BETWEEN $2 - 1 AND $2 + 1
        AND duration_bucket BETWEEN $3 - 1 AND $3 + 1
        AND bpps > 0
      GROUP BY is_compressed
     HAVING count(*) >= $4`,
    [shape.media, pixelBucket, durationBucket, minSamples],
  );
  let compressed: BaselineCurve | null = null;
  let uncompressed: BaselineCurve | null = null;
  for (const r of rows) {
    const curve = toCurve(r);
    if (r.is_compressed) compressed = curve;
    else uncompressed = curve;
  }
  return { compressed, uncompressed };
}

/**
 * DOES THIS FILE LOOK COMPRESSED? — the charter's question, answered from the learned distribution.
 *
 * The decision is a two-hypothesis z-score test on `ln(bpps)`, and it abstains in FOUR distinct ways, each
 * of which is a real state of a young baseline rather than an error:
 *
 *   1. The shape is unusable (no dimensions, zero-length file) — there is no bpps to test.
 *   2. Neither hypothesis cleared the n≥12 floor — the cell has not been learned yet. THIS IS THE COMMON
 *      CASE ON THIS MACHINE and will be for months.
 *   3. Only ONE hypothesis cleared the floor and the file is beyond 2σ of it — we can say the file is not
 *      that, which is not the same as knowing what it is.
 *   4. Both cleared the floor and the file is beyond 2σ of BOTH — it is off the end of everything we have
 *      seen, and picking the nearer of two curves that both reject it would be a confident guess.
 *
 * `unknown` is what `badges.ts` treats as "keep using the extension heuristic".
 */
export async function classifyCompression(shape: MediaShape, minSamples = MIN_CELL_SAMPLES): Promise<BaselineAnswer> {
  if (!(shape.width > 0) || !(shape.height > 0) || !(shape.sizeBytes > 0)) {
    return {
      verdict: "unknown",
      reason: "no usable shape (width, height and size are all required to compute bits per pixel per second)",
      bpps: null,
      compressed: null,
      uncompressed: null,
    };
  }
  const bpps = bppsFor(shape);
  const { compressed, uncompressed } = await fitCell(shape, minSamples);
  const base = { bpps, compressed, uncompressed };

  if (!compressed && !uncompressed) {
    return {
      ...base,
      verdict: "unknown",
      reason:
        `no cell for ${shape.media} at this resolution and duration has reached ${minSamples} samples yet — ` +
        `the extension heuristic stays in charge`,
    };
  }

  const x = Math.log(bpps);
  const zOf = (c: BaselineCurve | null): number | null =>
    c && Number.isFinite(c.sigmaLog) && c.sigmaLog > 0 ? Math.abs(x - c.muLog) / c.sigmaLog : null;
  const zc = zOf(compressed);
  const zu = zOf(uncompressed);

  if (zc !== null && zu !== null) {
    if (zc > MAX_Z && zu > MAX_Z) {
      return {
        ...base,
        verdict: "unknown",
        reason: `${bpps.toFixed(4)} bpps is more than ${MAX_Z}σ from both learned curves — nothing we have seen describes it`,
      };
    }
    return zc <= zu
      ? { ...base, verdict: "compressed", reason: `${zc.toFixed(2)}σ from the compressed curve vs ${zu.toFixed(2)}σ from the uncompressed one` }
      : { ...base, verdict: "uncompressed", reason: `${zu.toFixed(2)}σ from the uncompressed curve vs ${zc.toFixed(2)}σ from the compressed one` };
  }

  // Exactly one hypothesis is learned. It can only ever CONFIRM, never rule out by elimination: "this is
  // not what a compressed file of this shape looks like" does not make it an uncompressed one, because the
  // uncompressed curve is precisely what we have not learned.
  if (zc !== null) {
    return zc <= MAX_Z
      ? { ...base, verdict: "compressed", reason: `${zc.toFixed(2)}σ from the compressed curve (the uncompressed one is not learned yet)` }
      : { ...base, verdict: "unknown", reason: `${zc.toFixed(2)}σ from the compressed curve, and no uncompressed curve to compare against` };
  }
  if (zu !== null) {
    return zu <= MAX_Z
      ? { ...base, verdict: "uncompressed", reason: `${zu.toFixed(2)}σ from the uncompressed curve (the compressed one is not learned yet)` }
      : { ...base, verdict: "unknown", reason: `${zu.toFixed(2)}σ from the uncompressed curve, and no compressed curve to compare against` };
  }
  return {
    ...base,
    verdict: "unknown",
    reason: "the cell cleared the sample floor but its spread could not be estimated",
  };
}

// ── reporting: how much has actually been learned ───────────────────────────────────────────────────────

export interface BaselineCoverageCell {
  media: "video" | "image";
  pixelBucket: number;
  durationBucket: number;
  isCompressed: boolean;
  n: number;
}

/**
 * Every (media, pixel bucket, duration bucket, label) cell and its sample count — the honest coverage
 * report, and the number the slice's verification quotes as "how many cells clear n≥12".
 *
 * Reported per EXACT cell, not per widened cell: a widened query can clear the floor by borrowing from
 * neighbours, and conflating "this cell is learned" with "this cell's neighbourhood is learned" would
 * overstate how much the baseline actually knows.
 */
export async function baselineCoverage(): Promise<BaselineCoverageCell[]> {
  const rows = await q<{
    media: "video" | "image";
    pixel_bucket: number;
    duration_bucket: number;
    is_compressed: boolean;
    n: string;
  }>(
    `SELECT media, pixel_bucket, duration_bucket, is_compressed, count(*)::text AS n
       FROM ${S}.compression_sample
      GROUP BY media, pixel_bucket, duration_bucket, is_compressed
      ORDER BY media, pixel_bucket, duration_bucket, is_compressed`,
  );
  return rows.map((r) => ({
    media: r.media,
    pixelBucket: r.pixel_bucket,
    durationBucket: r.duration_bucket,
    isCompressed: r.is_compressed,
    n: Number(r.n),
  }));
}

/** Total samples held. `count(*)` after two consecutive full backfill runs must be IDENTICAL — the
 *  idempotency assertion for area 11, and the thing `compression_sample_ident` exists to guarantee. */
export async function sampleCount(): Promise<number> {
  const row = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.compression_sample`);
  return Number(row?.n ?? 0);
}
