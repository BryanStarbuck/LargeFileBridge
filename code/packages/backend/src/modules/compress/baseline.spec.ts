// THE LEARNED BASELINE — the arithmetic, and THE ABSTENTION PATH, which is the branch that actually runs
// in production today.
//
// Two halves:
//
//   1. PURE. `bppsFor` / `cellFor` must reproduce the STORED GENERATED columns exactly (0010), or a live
//      question and a stored sample land in different cells and the model quietly answers from the wrong
//      neighbourhood. `parseProbe` must recognise ffprobe's "N/A" rather than coercing it to NaN.
//
//   2. AGAINST A DATABASE, opt-in. The classifier is a SQL aggregate; there is no honest way to test its
//      verdicts without one. It SKIPS without a database because that is the documented `auto` posture and
//      not a failure (R2) — and `vitest.config.ts` deliberately clamps the whole suite to `LFB_DB_MODE=off`
//      so no spec can touch the user's real database. Point it at a scratch one to make it mean something:
//
//        LFB_GATE_DATABASE_URL=postgresql://localhost:5432/<db> \
//          CI=true ./node_modules/.bin/vitest run src/modules/compress/baseline.spec.ts
//
// THE MOST IMPORTANT TEST IN THIS FILE IS THE ONE THAT ASSERTS 'unknown'. Seeding this machine's whole
// corpus produces 49 samples across 29 cells, the largest holding 4 — so ZERO cells clear the n>=12 floor
// and the classifier abstains everywhere. That is the design working: a wrong "uncompressed" badge is how a
// user is talked into a needless lossy generation on a file that was already finished. If this test ever
// starts failing because a verdict appeared, the floor has been lowered and somebody should say why.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bppsFor, cellFor, classifyCompression, MIN_CELL_SAMPLES } from "./baseline.service.js";
import { parseProbe } from "./baseline-backfill.js";
import { exec, refreshDbHealth } from "../../shared/persistence/db.js";
import { probeDatabase, resolveDbMode, DB_SCHEMA as S } from "../../shared/persistence/pool.js";

if (process.env.LFB_GATE_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.LFB_GATE_DATABASE_URL;
  process.env.LFB_DB_MODE = "required";
}
const reachable = resolveDbMode() !== "off" && (await probeDatabase()).reachable;
if (reachable) await refreshDbHealth();

describe("bpps and the cell coordinates", () => {
  it("computes bits per pixel per second the way the stored GENERATED column does", () => {
    // 1920x1080 for 100 s at 10,000,000 bytes: 8e7 bits / 2.0736e8 pixel-seconds.
    expect(bppsFor({ media: "video", width: 1920, height: 1080, durationS: 100, sizeBytes: 10_000_000 })).toBeCloseTo(
      (10_000_000 * 8) / (1920 * 1080 * 100),
      12,
    );
  });

  it("treats a still image as one second, which is what the column's COALESCE does", () => {
    const still = bppsFor({ media: "image", width: 1000, height: 1000, durationS: null, sizeBytes: 125_000 });
    expect(still).toBeCloseTo(1, 12); // 1e6 bits over 1e6 pixels = 1 bit per pixel
  });

  it("buckets on log2, matching `floor(log(2, w*h))` and `floor(log(2, duration))`", () => {
    expect(cellFor({ media: "image", width: 1024, height: 1024, durationS: null, sizeBytes: 1 })).toEqual({
      pixelBucket: 20, // 2^20 pixels exactly
      durationBucket: 0, // a still is one second, and log2(1) is 0
    });
    expect(cellFor({ media: "video", width: 1920, height: 1080, durationS: 197, sizeBytes: 1 })).toEqual({
      pixelBucket: 20, // 2,073,600 → between 2^20 and 2^21
      durationBucket: 7, // 197 s → between 2^7 and 2^8
    });
  });
});

describe("parseProbe", () => {
  it("reads width, height, codec and container", () => {
    const s = parseProbe("codec_name=h264\nwidth=1920\nheight=1080\nformat_name=mov,mp4\nduration=197.09\n", true);
    expect(s).toEqual({ width: 1920, height: 1080, durationS: 197.09, codec: "h264", container: "mov,mp4" });
  });

  it("gives a STILL no duration, even when the image2 demuxer invents one", () => {
    // Measured on a real JPEG: ffprobe reports `duration=0.040000` through the image2 demuxer. Storing that
    // would put every image in duration bucket -5 instead of 0 and violate `duration_s > 0` semantics.
    const s = parseProbe("codec_name=mjpeg\nwidth=1272\nheight=414\nformat_name=image2\nduration=0.040000\n", false);
    expect(s?.durationS).toBeNull();
    expect(s?.width).toBe(1272);
  });

  it("recognises ffprobe's N/A rather than coercing it to NaN", () => {
    const s = parseProbe("width=640\nheight=480\nduration=N/A\n", true);
    expect(s?.durationS).toBeNull();
  });

  it("returns null when there is no usable shape at all", () => {
    expect(parseProbe(null, true)).toBeNull();
    expect(parseProbe("format_name=matroska\n", true)).toBeNull();
    expect(parseProbe("width=0\nheight=0\n", true)).toBeNull();
  });
});

describe("classifyCompression — the shapes that need no database", () => {
  it("abstains when the shape is unusable, because there is no bpps to test", async () => {
    const a = await classifyCompression({ media: "video", width: 0, height: 0, durationS: 10, sizeBytes: 100 });
    expect(a.verdict).toBe("unknown");
    expect(a.bpps).toBeNull();
    const b = await classifyCompression({ media: "image", width: 100, height: 100, durationS: null, sizeBytes: 0 });
    expect(b.verdict).toBe("unknown");
  });
});

describe.skipIf(!reachable)("classifyCompression — against a real baseline table", () => {
  beforeAll(async () => {
    await exec(`DELETE FROM ${S}.compression_sample WHERE label_source = 'user_confirmed'`);
  });
  afterAll(async () => {
    await exec(`DELETE FROM ${S}.compression_sample WHERE label_source = 'user_confirmed'`);
  });

  it("ANSWERS 'unknown' BELOW THE FLOOR — the state this product is actually in", async () => {
    // Eleven samples: one short of the floor, on both hypotheses. The extension heuristic stays in charge.
    await seed(11, true);
    await seed(11, false);
    const a = await classifyCompression(shape(2_000_000));
    expect(a.verdict).toBe("unknown");
    expect(a.reason).toContain(`${MIN_CELL_SAMPLES} samples`);
  });

  it("abstains for a REAL corpus shape — 1080p, 197 s, the largest cell this machine has is 4", async () => {
    // The measured state of the product, asserted rather than asserted-about-in-a-comment: seeding all 74
    // compression records yields 49 samples over 29 cells and ZERO of them reach n>=12, so every real
    // question still falls through to `badges.ts`'s extension heuristic. An empty table answers the same
    // way, so this holds on a bare scratch database too — the assertion is about the FLOOR, not the data.
    const real = await classifyCompression({
      media: "video",
      width: 1920,
      height: 1080,
      durationS: 197,
      sizeBytes: 22_593_106,
    });
    expect(real.verdict).toBe("unknown");
  });

  it("answers once BOTH hypotheses clear the floor, and picks the nearer curve", async () => {
    await seed(12, true); // compressed cluster, around 2 MB at this shape
    await seed(12, false); // uncompressed cluster, 10x that
    expect((await classifyCompression(shape(1_990_656))).verdict).toBe("compressed");
    expect((await classifyCompression(shape(19_906_560))).verdict).toBe("uncompressed");
  });

  it("abstains for a file more than 2σ from BOTH curves rather than picking the nearer bad fit", async () => {
    await seed(12, true);
    await seed(12, false);
    // Four orders of magnitude below the compressed cluster: nothing we have learned describes it.
    expect((await classifyCompression(shape(200))).verdict).toBe("unknown");
  });
});

/**
 * The synthetic shape every database test uses — 1920x1080 at ONE MILLION SECONDS.
 *
 * The duration is absurd on purpose, and it is the fix for a real failure this spec caught on its first
 * run: `fitCell` widens by ±1 bucket on BOTH axes, so a "60-second 1080p" fixture silently pooled with the
 * 20 real video samples the corpus seeds into duration buckets 3-9, and eleven fixture rows cleared a floor
 * they were written to sit below. 10^6 s is duration bucket 19; the widened window 18-20 cannot reach any
 * real sample, so the fixture is isolated by the model's own coordinates rather than by hoping the table is
 * empty.
 */
function shape(sizeBytes: number): Parameters<typeof classifyCompression>[0] {
  return { media: "video", width: 1920, height: 1080, durationS: 1_000_000, sizeBytes };
}

/**
 * Insert `n` synthetic samples into the isolated (video, pixel bucket 20, duration bucket 19) cell.
 *
 * They are labelled `user_confirmed` — a real `label_source` in the enum, and the only one no backfill
 * writes — so this spec can clear its own rows without ever touching a seeded one. The sizes are spread so
 * `stddev_samp` is finite: a cell with zero spread would make every z-score infinite, which is a different
 * bug hiding behind a passing test.
 */
async function seed(n: number, isCompressed: boolean): Promise<void> {
  const durationS = 1_000_000;
  const base = isCompressed ? 2_000_000 : 20_000_000;
  for (let i = 0; i < n; i++) {
    const size = Math.round(base * (1 + (i - n / 2) * 0.01));
    await exec(
      `INSERT INTO ${S}.compression_sample
         (media, content_hash, duration_s, width, height, size_bytes, is_compressed, label_source)
       VALUES ('video', $1, $2, 1920, 1080, $3, $4, 'user_confirmed')
       ON CONFLICT ON CONSTRAINT compression_sample_ident DO NOTHING`,
      [`spec:${isCompressed ? "c" : "u"}:${i}`, durationS, size, isCompressed],
    );
  }
}
