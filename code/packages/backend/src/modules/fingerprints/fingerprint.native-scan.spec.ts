// The bulk directory scan (apis.mdx §7.9) end to end against the REAL Go engine: a job walks a temp tree
// with the extension filter, fingerprints natively, defers AVIF to the sharp path, answers cached files
// without reading them, writes the CSV, and stores values the per-file path then reuses. Skipped when the
// binary is not built (`just build-pdq`).
import { afterAll, beforeAll, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

process.env.LFB_DB_MODE = "off"; // memory tier only — never touch a real database from a unit test
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-native-state-"));
process.env.LFB_STATE_DIR = stateDir; // the job's CSV must never land in the live state root
const { startJob, waitForJob, getJob } = await import("./fingerprint.jobs.js");
const { fingerprintPath } = await import("./fingerprint.service.js");
const { pdqBinaryPath, stopPdqSidecar } = await import("./pdq-sidecar.js");
const { buildGoRequest, splitExcludes } = await import("./fingerprint.native-scan.js");
const { clearMemoryTier } = await import("./fingerprint.store.js");

const HAVE_BIN = fs.existsSync(pdqBinaryPath());
let HAVE_FFMPEG = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  HAVE_FFMPEG = false;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-native-spec-"));

async function scenePng(file: string, w: number, h: number): Promise<void> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set([(x * 3 + y) & 255, (y * 2) & 255, ((x ^ y) * 5) & 255], (y * w + x) * 3);
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(file);
}

beforeAll(async () => {
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.mkdirSync(path.join(dir, "site", "build"), { recursive: true });
  await scenePng(path.join(dir, "a.png"), 400, 300);
  await sharp(path.join(dir, "a.png")).resize(200).jpeg({ quality: 40 }).toFile(path.join(dir, "sub", "a_small.jpg"));
  await sharp(path.join(dir, "a.png")).avif().toFile(path.join(dir, "a.avif"));
  await sharp(path.join(dir, "a.png")).jpeg().toFile(path.join(dir, "site", "build", "copy.jpg"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "not media");
  if (HAVE_FFMPEG) {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-pix_fmt", "yuv420p", path.join(dir, "clip.mp4")]);
  }
});

afterAll(() => {
  stopPdqSidecar();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("exclude_dirs: bare names match anywhere, slashed entries are paths under dir", () => {
  expect(splitExcludes("/r", ["build", "site/build/", "/abs/x"])).toEqual({ names: ["build"], paths: ["/r/site/build", "/abs/x"] });
  const req = buildGoRequest({
    dir: "/r", recursive: true, extensions: ["mp4"], kinds: ["image", "video"], excludeDirs: ["site/build"],
    skipGeneratedDirs: false, includeOnlineOnly: false, cpuPercent: 80, maxFiles: 10,
    video: { intervalS: 1, maxFrames: 3600, timeoutS: 900 }, known: [],
  });
  expect(req.skip_dirs).toContain(".git");
  expect(req.skip_dirs).not.toContain("build"); // generated dirs only when skip_generated_dirs
  expect(req.skip_paths).toEqual(["/r/site/build"]);
  expect(req.cpu_percent).toBe(80);
});

test.skipIf(!HAVE_BIN)("bulk scan: extension filter, native + deferred images, video, CSV, cache", { timeout: 120_000 }, async () => {
  clearMemoryTier();
  const job = startJob({ kind: "native-directory", dir, excludeDirs: ["site/build"], skipGeneratedDirs: false });
  expect(await waitForJob(job.id, 110_000)).toBe(true);
  const j = getJob(job.id)!;
  const byName = new Map(j.results.map((r) => [path.basename(r.path), r]));
  expect(j.job.status).toBe("done");
  expect(j.job.scope).toMatchObject({ kind: "directory", engine: "native" });
  expect(byName.has("copy.jpg")).toBe(false); // excluded path
  expect(byName.has("notes.txt")).toBe(false); // not media
  expect(byName.get("a.png")?.fingerprint?.strategy).toBe("go-area");
  expect(byName.get("a.avif")?.ok).toBe(true); // deferred to sharp, still fingerprinted
  expect(byName.get("a.avif")?.fingerprint?.strategy).not.toBe("go-area");
  expect(j.job.deferred).toBe(1);
  if (HAVE_FFMPEG) {
    expect(byName.get("clip.mp4")?.fingerprint?.kind).toBe("video");
    expect(byName.get("clip.mp4")?.fingerprint?.frame_count).toBeGreaterThan(0);
  }
  // CSV: one row per file, path + fingerprint columns, written into the (test) state root.
  expect(j.job.csv_path).toBeTruthy();
  const csv = fs.readFileSync(j.job.csv_path!, "utf8").trim().split("\n");
  expect(csv[0].startsWith("path,ok,kind,algo,value,")).toBe(true);
  expect(csv.length - 1).toBe(j.results.length);

  // The native value is stored under the same engine version, so the per-file path reuses it…
  const again = await fingerprintPath(path.join(dir, "a.png"));
  expect(again.source).toBe("memory");
  expect(again.fingerprint?.value).toBe(byName.get("a.png")?.fingerprint?.value);

  // …and a second bulk scan answers every unchanged file from the store without reading it.
  const job2 = startJob({ kind: "native-directory", dir, extensions: ["png", "jpg"], excludeDirs: ["site/build"], skipGeneratedDirs: false });
  expect(await waitForJob(job2.id, 60_000)).toBe(true);
  const j2 = getJob(job2.id)!;
  expect(j2.results.map((r) => path.basename(r.path)).sort()).toEqual(["a.png", "a_small.jpg"]);
  expect(j2.job.cached).toBe(2);
});
