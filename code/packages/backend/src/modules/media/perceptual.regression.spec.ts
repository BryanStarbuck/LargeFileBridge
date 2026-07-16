// FINGERPRINT REGRESSION — the gate for the downscale-before-decode change (2_2_do.mdx row B10,
// to_fix.mdx §3.3.1 + §9 "Fingerprint regression — hash the existing corpus pre/post downscale; assert
// Hamming distance within threshold. Gates §3.3.1 — a fingerprint change silently breaks dedup").
//
// Runner: vitest (`pnpm test` in this package).
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT THE OTHER ONE.
// `perceptual.no-network.spec.ts` asserts resize-INVARIANCE as a property, using 256px images. Every one
// of those is *below* HASH_DECODE_MAX_EDGE (512), so `withoutEnlargement: true` means they are decoded
// exactly as they always were — that suite cannot see the downscale path at all, and would pass
// unchanged even if the downscale corrupted every large image's hash.
//
// The risk B10 names is specific: stored fingerprints in existing sidecars were computed by the OLD
// full-resolution decode. If the new bounded decode returns different hashes for images OVER 512px, then
// dedup silently breaks against the whole existing corpus — no error, no log, just content that stops
// matching itself. `2_2_do.mdx §J` ordered this test FIRST, before B1–B8; it was written after, so this
// is the verification that was owed.
//
// THE ORACLE. We have no checked-in corpus of pre-change hashes, and inventing one now would just record
// today's behavior as "correct" — a test that can only ever agree with itself. Instead this recomputes
// the OLD algorithm directly (`legacyFullResHash` below: full-res decode, no resize — exactly the code
// that produced the stored sidecars) and asserts the shipped `fingerprintImage` agrees with it. That is
// the real question B10 asks, and it needs no fixture to answer.
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { bmvbhash } from "blockhash-core";
import { fingerprintImage, hammingDistance } from "./perceptual.service.js";

const BLOCKHASH_BITS = 16; // must match perceptual.service.ts

/** The PRE-CHANGE decode: full resolution, no resize — the code path that computed every hash already on
 *  disk. Kept here deliberately as the regression oracle; it is not used in production. */
async function legacyFullResHash(buf: Buffer): Promise<string> {
  const { data, info } = await sharp(buf, { failOn: "none" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return bmvbhash({ width: info.width, height: info.height, data }, BLOCKHASH_BITS);
}

/** A deterministic, non-flat test image with real structure at multiple scales — a flat gradient would
 *  hash identically no matter what we did to it and would prove nothing. */
async function syntheticPhoto(width: number, height: number, seed = 1): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      // Coarse blobs (survive downscale) + a fine checker (destroyed by downscale). The mix is the point:
      // if the fingerprint were driven by high-frequency detail, downscaling WOULD change it.
      const coarse = Math.sin((x / width) * Math.PI * 3 * seed) * Math.cos((y / height) * Math.PI * 2 * seed);
      const fine = ((x >> 1) + (y >> 1)) % 2 === 0 ? 18 : -18;
      const v = 128 + coarse * 90 + fine;
      data[i] = Math.max(0, Math.min(255, v));
      data[i + 1] = Math.max(0, Math.min(255, v * 0.8 + 20));
      data[i + 2] = Math.max(0, Math.min(255, 255 - v * 0.6));
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

// THE GATE. Oversize images are the only ones the downscale touches, so they are the only ones at risk.
// A tight threshold: blockhash is a 256-bit hash, so 16 bits is ~6% — comfortably inside the dedup
// threshold while still failing loudly if the downscale actually altered what the hash sees.
const MAX_DRIFT_BITS = 16;

for (const [w, h, label] of [
  [2000, 1500, "3 MP (over the 512 edge)"],
  [4000, 3000, "12 MP"],
  [6000, 4000, "24 MP — the photo from to_fix §3.1"],
] as Array<[number, number, string]>) {
  test(`downscale-before-decode is hash-stable vs. the legacy full-res decode: ${label}`, async () => {
    const buf = await syntheticPhoto(w, h);
    const legacy = await legacyFullResHash(buf);
    const current = (await fingerprintImage(buf)).value;
    const drift = hammingDistance(legacy, current);
    assert.ok(
      drift <= MAX_DRIFT_BITS,
      `downscale changed the fingerprint by ${drift} bits (max ${MAX_DRIFT_BITS}) for ${label} — ` +
        `stored sidecar fingerprints would no longer match their own files. B1's premise is broken.`,
    );
  });
}

test("images UNDER the 512 edge are bit-identical to the legacy decode (withoutEnlargement)", async () => {
  // The service comments claim exactly this: "an image already under 512px is decoded EXACTLY as before —
  // so every small image's stored fingerprint is bit-identical across this change". Pin that claim: it is
  // what makes the change safe for the majority of an existing corpus.
  for (const [w, h] of [
    [320, 240],
    [512, 384],
    [500, 500],
  ]) {
    const buf = await syntheticPhoto(w, h, 2);
    const legacy = await legacyFullResHash(buf);
    const current = (await fingerprintImage(buf)).value;
    assert.equal(current, legacy, `${w}x${h} must be bit-identical, not merely close`);
  }
});

test("the decode ceiling refuses an absurd image rather than decoding it (§3.3.3)", async () => {
  // 64 MP is the ceiling; sharp's own limitInputPixels also guards the header read. Either way the
  // contract is the same: THROW, never decode. An OOM is a lost batch; a missing fingerprint is one
  // lost signal that the caller logs and continues past.
  const huge = await sharp({
    create: { width: 9000, height: 9000, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  await assert.rejects(() => fingerprintImage(huge), /beyond|pixels|limit/i, "a 81MP image must be refused");
});

test("a real resize still matches after the change — dedup's actual job (perceptual_fingerprint.mdx §3)", async () => {
  // The end-to-end property the corpus depends on: the same photo at two resolutions is ONE piece of
  // content. This is what would silently break if the downscale were wrong.
  const big = await syntheticPhoto(3000, 2000, 3);
  const small = await sharp(big).resize(900).jpeg({ quality: 70 }).toBuffer();
  const drift = hammingDistance((await fingerprintImage(big)).value, (await fingerprintImage(small)).value);
  assert.ok(drift <= 24, `a resized+recompressed copy drifted ${drift} bits — dedup would miss it`);
});

// ── additions: the two gaps the cases above leave open (B10 (c)/(d)) ──────────────────────────────────

/** A HOSTILE image for the downscale: deterministic per-pixel noise, i.e. detail that exists ONLY at full
 *  resolution and that averaging to 512px must destroy. `syntheticPhoto` above is smooth — its hash rides
 *  on a coarse sine that survives any resize, so it scores Hamming 0 whether or not the downscale is sound
 *  and cannot, on its own, distinguish a working change from a broken one. This is the case that can. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
async function noisyPhoto(width: number, height: number, amplitude: number, seed = 7): Promise<Buffer> {
  const rand = lcg(seed);
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const coarse = Math.sin((x / width) * Math.PI * 3) * Math.cos((y / height) * Math.PI * 2) * 90;
      for (let c = 0; c < channels; c++) {
        data[i + c] = Math.max(0, Math.min(255, 128 + coarse + (rand() - 0.5) * 2 * amplitude));
      }
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

test("downscale stays hash-stable even on heavy sensor-grain noise — the case a smooth image cannot test", async () => {
  // Measured when written (2026-07-16): Hamming 0 at ±40 and ±90 for 1024x768 / 2000x1500 / 4000x3000;
  // a single 2-bit blip at ±127 (i.e. near-pure noise). The coarse structure a real photo has is exactly
  // what blockhash keys on, and it is preserved. Threshold matches MAX_DRIFT_BITS above, deliberately:
  // noise is the WORST case, so if it needed a looser bound than smooth content, that would be the finding.
  for (const [w, h] of [
    [1024, 768],
    [2000, 1500],
  ] as Array<[number, number]>) {
    for (const amp of [40, 90]) {
      const buf = await noisyPhoto(w, h, amp);
      const drift = hammingDistance(await legacyFullResHash(buf), (await fingerprintImage(buf)).value);
      assert.ok(
        drift <= MAX_DRIFT_BITS,
        `${w}x${h} noise±${amp}: downscale drifted ${drift} bits (max ${MAX_DRIFT_BITS}) — high-frequency ` +
          `detail is changing the hash, so B1 is not safe for detailed photos.`,
      );
    }
  }
});

test("a PATH and a Buffer of the same bytes fingerprint identically (B1's readFileSync removal)", async () => {
  // B1/§3.3.2 changed callers from `fingerprintImage(readFileSync(abs))` to `fingerprintImage(abs)` so the
  // file never enters the heap. That is only a safe swap if the two entry points agree EXACTLY — if the
  // path form differed at all, every fingerprint recomputed after the change would drift from its stored
  // sidecar, which is the same corpus-invalidation B10 exists to prevent, arriving through the other door.
  // Bit-identical is the bar here, not "within threshold": same bytes, same decode, same hash.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-fp-pathbuf-"));
  try {
    for (const [w, h] of [
      [1024, 768], // over the 512 edge — exercises the resize path
      [300, 300], // under it — exercises the withoutEnlargement path
    ] as Array<[number, number]>) {
      const buf = await noisyPhoto(w, h, 60, 5);
      const file = path.join(dir, `${w}x${h}.png`);
      fs.writeFileSync(file, buf);

      const fromPath = await fingerprintImage(file);
      const fromBuffer = await fingerprintImage(buf);
      assert.equal(fromPath.value, fromBuffer.value, `${w}x${h}: path and Buffer must hash identically`);
      assert.equal(fromPath.quality, fromBuffer.quality, `${w}x${h}: quality must match too`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
