// Warm-re-scan caches (duplicates.mdx §7.6 — "a warm re-scan hashes almost nothing"). Two small YAML
// stores under `<state root>/videos/`:
//
//   • hash_cache.yaml   — abs path → { size, mtime_ms, sha256 }. A file whose size+mtime are unchanged
//                          reuses its full-content sha256 instead of re-streaming gigabytes.
//   • image_fp.yaml     — sha256 → { algo, value, quality }. Image perceptual fingerprints keyed by
//                          CONTENT hash, so staleness is sha256-invalidation by construction (§7.6).
//
// Both are machine-local computed state (Category B) and both are written atomically. Video frame lists
// (`vpdq/<sha256>.vpdq`) and MPEG-7 signatures (`signatures/<sha256>.mpeg7sig`) are cached as individual
// files by vpdq.service.ts / mpeg7-signature.service.ts under the same sha256-keyed rule.
import path from "node:path";
import fs from "node:fs";
import YAML from "yaml";
import type { PerceptualFingerprint } from "@lfb/shared";
import { videosDir, writeFileAtomic } from "./paths.js";
import { sha256File } from "./exec.js";
import { log } from "../../shared/logging.js";

interface HashEntry {
  size: number;
  mtime_ms: number;
  sha256: string;
}

const HASH_CACHE_FILE = () => path.join(videosDir(), "hash_cache.yaml");
const IMAGE_FP_FILE = () => path.join(videosDir(), "image_fp.yaml");

function readYamlMap<T>(file: string, key: string): Record<string, T> {
  try {
    const doc = YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> | null;
    const m = doc?.[key];
    return m && typeof m === "object" ? (m as Record<string, T>) : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("videos", `cache read failed (${path.basename(file)}): ${(e as Error).message} — starting empty`);
    }
    return {};
  }
}

/** A run-scoped view over both caches: load once at engine start, save once at engine end. */
export class VideosCaches {
  private hashes = readYamlMap<HashEntry>(HASH_CACHE_FILE(), "entries");
  private imageFps = readYamlMap<PerceptualFingerprint>(IMAGE_FP_FILE(), "entries");
  private dirty = false;

  /** Full-content sha256, from cache when size+mtime are unchanged, else streamed and remembered. */
  async sha256(abs: string, size: number, mtimeMs: number): Promise<string> {
    const hit = this.hashes[abs];
    if (hit && hit.size === size && Math.round(hit.mtime_ms) === Math.round(mtimeMs)) return hit.sha256;
    const sha = await sha256File(abs);
    this.hashes[abs] = { size, mtime_ms: Math.round(mtimeMs), sha256: sha };
    this.dirty = true;
    return sha;
  }

  /** Cached image fingerprint for a content hash, or null. */
  imageFp(sha256: string): PerceptualFingerprint | null {
    return this.imageFps[sha256] ?? null;
  }

  rememberImageFp(sha256: string, fp: PerceptualFingerprint): void {
    this.imageFps[sha256] = { algo: fp.algo, value: fp.value, quality: fp.quality ?? null } as PerceptualFingerprint;
    this.dirty = true;
  }

  /** Persist both caches (atomic). Never throws — a cache that cannot be written costs the NEXT run time,
   *  not this run its results. */
  save(): void {
    if (!this.dirty) return;
    try {
      writeFileAtomic(HASH_CACHE_FILE(), YAML.stringify({ schema_version: 1, entries: this.hashes }));
      writeFileAtomic(IMAGE_FP_FILE(), YAML.stringify({ schema_version: 1, entries: this.imageFps }));
      this.dirty = false;
    } catch (e) {
      log.warn("videos", `cache save failed: ${(e as Error).message}`);
    }
  }
}
