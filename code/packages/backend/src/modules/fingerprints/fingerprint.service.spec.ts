// Functional test against the REAL PDQ sidecar (code/sidecars/pdq). Skipped when the binary is not built
// (a machine without Go) — `just build-pdq` builds it.
import { beforeAll, afterAll, test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

process.env.LFB_DB_MODE = "off"; // memory tier only — never touch a real database from a unit test
const { fingerprintPath } = await import("./fingerprint.service.js");
const { pdqBinaryPath, stopPdqSidecar } = await import("./pdq-sidecar.js");
const { hammingDistance } = await import("../media/perceptual.service.js");
const { clearMemoryTier } = await import("./fingerprint.store.js");
const { flattenBoth } = await import("./fingerprint.service.js");

const HAVE_BIN = fs.existsSync(pdqBinaryPath());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-fp-spec-"));

async function png(file: string, size: number, fn: (x: number, y: number) => [number, number, number]): Promise<void> {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [r, g, b] = fn(x, y);
      raw.set([r, g, b], (y * size + x) * 3);
    }
  await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toFile(file);
}

beforeAll(async () => {
  const scene = (x: number, y: number): [number, number, number] => [
    (x * 3 + Math.round(40 * Math.sin(y / 9))) & 255,
    (y * 2 + Math.round(60 * Math.cos(x / 13))) & 255,
    ((x ^ y) * 5) & 255,
  ];
  await png(path.join(dir, "orig.png"), 400, scene);
  // Same content: downscaled and heavily recompressed to JPEG.
  await sharp(path.join(dir, "orig.png")).resize(160).jpeg({ quality: 25 }).toFile(path.join(dir, "small.jpg"));
  // Different content.
  await png(path.join(dir, "other.png"), 400, (x, y) => [(x * y) & 255, (255 - x) & 255, (y * 7) & 255]);
  fs.writeFileSync(path.join(dir, "notes.txt"), "not media");

  // A "window screenshot": opaque content with a 12%-wide see-through border (the shadow), then the two ways
  // other tools export it to JPEG — flattened on black, and on white.
  const S = 400;
  const rgba = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const inside = x > 48 && x < S - 48 && y > 48 && y < S - 48;
      rgba.set([(x * 5) & 255, (y * 3 + (x >> 2)) & 255, ((x + y) * 2) & 255, inside ? 255 : 60], i);
    }
  await sharp(rgba, { raw: { width: S, height: S, channels: 4 } }).png().toFile(path.join(dir, "window.png"));
  await sharp(path.join(dir, "window.png")).flatten({ background: "#000" }).jpeg({ quality: 70 }).toFile(path.join(dir, "window_black.jpg"));
  await sharp(path.join(dir, "window.png")).flatten({ background: "#fff" }).jpeg({ quality: 70 }).toFile(path.join(dir, "window_white.jpg"));
});

afterAll(() => {
  stopPdqSidecar();
  fs.rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!HAVE_BIN)("PDQ survives resize + heavy JPEG recompression, and tells different images apart", async () => {
  const a = await fingerprintPath(path.join(dir, "orig.png"));
  const b = await fingerprintPath(path.join(dir, "small.jpg"));
  const c = await fingerprintPath(path.join(dir, "other.png"));
  expect(a.ok && b.ok && c.ok).toBe(true);
  expect(a.fingerprint!.algo).toBe("pdq");
  expect(a.fingerprint!.value).toMatch(/^[0-9a-f]{64}$/);
  expect(hammingDistance(a.fingerprint!.value, b.fingerprint!.value)).toBeLessThanOrEqual(32);
  expect(hammingDistance(a.fingerprint!.value, c.fingerprint!.value)).toBeGreaterThan(64);
});

test.skipIf(!HAVE_BIN)("an unchanged file is answered from the store; a modified one is recomputed", async () => {
  clearMemoryTier();
  const f = path.join(dir, "orig.png");
  expect((await fingerprintPath(f)).source).toBe("computed");
  expect((await fingerprintPath(f)).source).toBe("memory");
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(f, later, later); // "modified after the fingerprint was computed"
  expect((await fingerprintPath(f)).source).toBe("computed");
  expect((await fingerprintPath(f, { force: true })).source).toBe("computed");
});

test.skipIf(!HAVE_BIN)("a transparent image matches BOTH its black- and white-flattened copies (value_alt)", async () => {
  const w = (await fingerprintPath(path.join(dir, "window.png"))).fingerprint!;
  expect(w.value_alt).toMatch(/^[0-9a-f]{64}$/);
  const nearest = (a: { value: string; value_alt: string | null }, b: { value: string; value_alt: string | null }) =>
    Math.min(
      ...[a.value, a.value_alt].filter(Boolean).flatMap((x) => [b.value, b.value_alt].filter(Boolean).map((y) => hammingDistance(x!, y!))),
    );
  for (const copy of ["window_black.jpg", "window_white.jpg"]) {
    const c = (await fingerprintPath(path.join(dir, copy))).fingerprint!;
    expect(c.value_alt).toBeNull(); // a JPEG is opaque: one hash
    expect(nearest(w, c), copy).toBeLessThanOrEqual(32);
  }
  // An opaque image never gets a second hash.
  expect((await fingerprintPath(path.join(dir, "other.png"))).fingerprint!.value_alt).toBeNull();
});

test("flattenBoth composites over white always, over black only when see-through", () => {
  const opaque = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]);
  expect(flattenBoth(opaque, 2, 1).black).toBeNull();
  const clear = Buffer.from([200, 100, 0, 0, 200, 100, 0, 128]);
  const r = flattenBoth(clear, 2, 1);
  expect([...r.white.subarray(0, 3)]).toEqual([255, 255, 255]); // fully transparent → the background
  expect([...r.black!.subarray(0, 3)]).toEqual([0, 0, 0]);
  expect(r.black![3]).toBe(100); // half-transparent: 200 × 128/255
});

test("failures are typed results, never throws", async () => {
  expect((await fingerprintPath(path.join(dir, "missing.png"))).code).toBe("not_found");
  expect((await fingerprintPath(path.join(dir, "notes.txt"))).code).toBe("not_media");
  expect((await fingerprintPath(dir)).code).toBe("not_a_file");
});
