// Guard + functional test for the perceptual fingerprint module (perceptual_fingerprint.mdx §6).
//
// Runner: vitest (`pnpm test` in this package). This file previously imported `node:test` and was never
// executed by any script — the package's `test` was a stub. Only the RUNNER import changed; every
// assertion below is the original.
//
// Two guarantees are asserted:
//   1. NO NETWORK: the module's source imports no http client / fetch / socket (charter hard requirement).
//   2. FUNCTIONAL: a resized + re-encoded copy of an image stays within the Hamming threshold of the
//      original, while a visually different image is far outside it.
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { fingerprintImage, hammingDistance, sameContent } from "./perceptual.service.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_SRC = fs.readFileSync(path.join(HERE, "perceptual.service.ts"), "utf8");

test("no-network guard: source imports no network client", () => {
  // Import/require of any networking module.
  const networkImport =
    /(?:from\s+|require\(\s*)["'](?:node:)?(?:http|https|net|tls|dgram|http2|axios|undici|got|node-fetch|ws|superagent|request)["']/;
  assert.equal(networkImport.test(SERVICE_SRC), false, "must not import any network module");

  // Direct network call sites that need no import.
  assert.equal(/\bfetch\s*\(/.test(SERVICE_SRC), false, "must not call fetch()");
  assert.equal(/\bXMLHttpRequest\b/.test(SERVICE_SRC), false, "must not use XMLHttpRequest");
  assert.equal(/new\s+WebSocket\b/.test(SERVICE_SRC), false, "must not open a WebSocket");
  assert.equal(/\bnavigator\.sendBeacon\b/.test(SERVICE_SRC), false, "must not use sendBeacon");

  // Belt-and-suspenders: the raw tokens 'http', 'axios', 'undici', 'node-fetch' must not appear anywhere,
  // including comments and URLs — so the module can never even reference a network destination.
  for (const banned of ["http", "axios", "undici", "node-fetch", "socket"]) {
    assert.equal(SERVICE_SRC.includes(banned), false, `source must not contain the token "${banned}"`);
  }
});

// Build a deterministic, non-flat raw RGB image from a per-pixel function, then encode it to PNG.
async function makePng(size: number, fn: (x: number, y: number) => [number, number, number]): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * size + x) * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

test("fingerprintImage: same content survives resize + re-encode; different content is far", async () => {
  // Image A: a smooth diagonal gradient with a warm channel tilt.
  const pngA = await makePng(256, (x, y) => {
    const g = (x + y) / 2;
    return [Math.min(255, g + 40), g, Math.max(0, 255 - g)];
  });
  // Image B: a high-frequency checkerboard — visually very different from A.
  const pngB = await makePng(256, (x, y) => {
    const on = (((x >> 4) + (y >> 4)) & 1) === 0;
    return on ? [20, 30, 40] : [230, 210, 190];
  });

  // A transformed copy of A: downscaled to 96px AND re-encoded to low-quality JPEG (a real LFB transform).
  const variantA = await sharp(pngA).resize(96, 96).jpeg({ quality: 35 }).toBuffer();

  const fpA = await fingerprintImage(pngA);
  const fpVariant = await fingerprintImage(variantA);
  const fpB = await fingerprintImage(pngB);

  // Shape.
  assert.equal(fpA.algo, "blockhash");
  assert.equal(fpA.value.length, 64, "256-bit blockhash is 64 hex chars");
  assert.equal(typeof fpA.quality, "number");

  const near = hammingDistance(fpA.value, fpVariant.value);
  const far = hammingDistance(fpA.value, fpB.value);

  assert.ok(near <= 32, `resized+recompressed copy should be within threshold, got Hamming ${near}`);
  assert.ok(far > 40, `different image should be far outside threshold, got Hamming ${far}`);

  // sameContent honors the same thresholds.
  assert.equal(sameContent(fpA, fpVariant), true, "transform-preserved copy is the same content");
  assert.equal(sameContent(fpA, fpB), false, "different image is not the same content");
});

test("sameContent: quality gate excludes flat frames, and cross-algo never matches", () => {
  // Two identical values but flagged low quality -> gated out of auto-matching.
  const flat = { algo: "blockhash", value: "0".repeat(64), quality: 1 };
  assert.equal(sameContent(flat, { ...flat }), false, "low-quality (flat) content is gated out");

  // Same value, unknown quality -> allowed (absence of a score is not a low score).
  const unknown = { algo: "blockhash", value: "a".repeat(64), quality: null };
  assert.equal(sameContent(unknown, { ...unknown }), true, "null quality is not gated");

  // A blockhash value and a vpdq value are never comparable, even if identical.
  const asImage = { algo: "blockhash", value: "a".repeat(64), quality: 50 };
  const asVideo = { algo: "vpdq", value: "a".repeat(64), quality: 50 };
  assert.equal(sameContent(asImage, asVideo), false, "cross-algo fingerprints never match");
});
