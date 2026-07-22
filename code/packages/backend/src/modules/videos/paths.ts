// The Videos feature's corner of Local Storage (duplicates.mdx §9, subsets.mdx §9) — everything the two
// dedicated scans persist lives under `<state root>/videos/`. Category-B computed state
// (artifact_placement_policy.mdx): state root only, never a working repo, never committed anywhere.
// Resolved through the ONE state-root resolver so LFB_STATE_DIR (and the vitest temp-dir redirect)
// govern these paths exactly like every other store — never hardcoded.
import path from "node:path";
import fs from "node:fs";
import { resolveStateDir, ensureDir } from "../../config/state-dir.js";

/** `<state root>/videos/` — created on demand. */
export function videosDir(): string {
  const dir = path.join(resolveStateDir(), "videos");
  ensureDir(dir);
  return dir;
}

/** `<state root>/videos/signatures/` — cached per-video MPEG-7 signatures, keyed by content sha256
 *  (subsets.mdx §7.4): a re-encode changes the hash and therefore gets a fresh signature. */
export function signaturesDir(): string {
  const dir = path.join(videosDir(), "signatures");
  ensureDir(dir);
  return dir;
}

/** `<state root>/videos/vpdq/` — cached per-video vPDQ frame lists (plain text lines
 *  `frame_number,hex,quality,timestamp` — duplicates.mdx §7.7), keyed by content sha256. */
export function vpdqDir(): string {
  const dir = path.join(videosDir(), "vpdq");
  ensureDir(dir);
  return dir;
}

/**
 * Atomic write (temp + rename) — the same discipline every store in the app uses (duplicates.mdx §9:
 * "rewritten whole each run, atomic temp + rename"). fsync before rename so a crash never leaves a
 * half-written CSV pretending to be the scan's durable output.
 */
export function writeFileAtomic(file: string, body: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}
