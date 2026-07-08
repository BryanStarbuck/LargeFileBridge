// Per-storage file tracking (storages.mdx §4.1). Builds and reads the hidden fingerprint index
// `<storage root>/.lfbridge/files.yaml`: one entry per LARGE file with a fingerprint (hash), size, and
// dates, plus its compressible kind and which media-analysis outputs exist. Node fs only (charter).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import type { StorageFileRow } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { compressInfo, HARD_SKIP } from "../fs/badges.js";
import { mapLimit, responsiveBudget } from "../../shared/concurrency.js";
import { log } from "../../shared/logging.js";

export const LFBRIDGE_DIR = ".lfbridge";
const FILES_YAML = "files.yaml";
const ANALYSIS_DIR = "analysis";
// Analysis outputs that still live as YAML under .lfbridge/analysis/<rel>/ (visuals-by-time; the
// compression record is tracked separately). Transcript + description are now SIDECARS beside the media —
// detected below by their extensions rather than a YAML here (Transcribe.mdx §3, ai_description.mdx §2).
const ANALYSIS_FILES: Record<string, string> = {
  visuals_by_time: "visuals_by_time.yaml",
};
// Keep in sync with TRANSCRIPTION_EXT / AI_DESCRIPTION_EXT in storage/artifact-placement.service.ts.
// Inlined (not imported) to avoid an import cycle — artifact-placement imports LFBRIDGE_DIR from here.
const TRANSCRIPTION_EXT = ".transcription";
const AI_DESCRIPTION_EXT = ".ai_description";
const MAX_FILES = 5000; // a safety cap so an enormous tree can't run the index unbounded (logged if hit).
const FINGERPRINT_CHUNK = 64 * 1024;

function filesYamlPath(root: string): string {
  return path.join(root, LFBRIDGE_DIR, FILES_YAML);
}

/** Which §6 analysis outputs already exist for a file. Transcript + description are detected by their
 *  SIDECAR beside the media (<root>/<rel-without-ext>.transcription / .ai_description); visuals-by-time is
 *  still a YAML under .lfbridge/analysis/<rel>/. */
export function analysisOutputs(root: string, rel: string): string[] {
  const out: string[] = [];
  const relNoExt = rel.slice(0, rel.length - path.extname(rel).length);
  const isFileAt = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isFileAt(path.join(root, relNoExt + TRANSCRIPTION_EXT))) out.push("transcript");
  if (isFileAt(path.join(root, relNoExt + AI_DESCRIPTION_EXT))) out.push("description");
  const dir = path.join(root, LFBRIDGE_DIR, ANALYSIS_DIR, rel);
  for (const [key, file] of Object.entries(ANALYSIS_FILES)) {
    if (isFileAt(path.join(dir, file))) out.push(key);
  }
  return out;
}

/** A cheap-but-robust fingerprint: hash of size + mtime + the head and tail bytes. ASYNC (fs.promises) so
 *  that MANY files' head/tail reads OVERLAP when fingerprinting fans out under mapLimit (the disk I/O is
 *  the cost, and async reads let the event loop drive several at once — parallelization.mdx §3). */
async function fingerprint(abs: string, st: fs.Stats): Promise<string | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    const h = crypto.createHash("sha256");
    h.update(String(st.size));
    h.update(String(Math.round(st.mtimeMs)));
    fh = await fs.promises.open(abs, "r");
    const headLen = Math.min(FINGERPRINT_CHUNK, st.size);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    h.update(head);
    if (st.size > FINGERPRINT_CHUNK) {
      const tailLen = Math.min(FINGERPRINT_CHUNK, st.size);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, Math.max(0, st.size - tailLen));
      h.update(tail);
    }
    return h.digest("hex").slice(0, 32);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * (Re)build `<root>/.lfbridge/files.yaml` from the large files under the storage. Returns the count.
 * Two phases (parallelization.mdx §3): (1) a cheap metadata-only walk collects the large-file entries; then
 * (2) the per-file FINGERPRINTING (head+tail read + sha256) fans out WIDE across files, bounded by the
 * RESPONSIVE budget (cores − 2), so a large storage indexes quickly without pinning the app. Indexing
 * MULTIPLE storages parallelizes across storages too — each writes only its own `.lfbridge/files.yaml`.
 */
export async function indexStorageFiles(root: string): Promise<number> {
  const threshold = getAppConfig().big_file.threshold_bytes;

  // Phase 1 — metadata-only walk: collect the eligible large files (bounded by MAX_FILES). No hashing yet.
  interface Entry { rel: string; name: string; abs: string; st: fs.Stats; }
  const collected: Entry[] = [];
  const walk = (dir: string): void => {
    if (collected.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (collected.length >= MAX_FILES) break;
      const name = ent.name;
      if (name === LFBRIDGE_DIR || name === ".git" || name === "node_modules" || HARD_SKIP.has(name)) continue;
      const abs = path.join(dir, name);
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size < threshold) continue;
      collected.push({ rel: path.relative(root, abs), name, abs, st });
    }
  };
  walk(root);
  const capped = collected.length >= MAX_FILES;

  // Phase 2 — fingerprint IN PARALLEL across files (bounded by the responsive budget). Each result carries
  // its rel key so the map is assembled deterministically after; per-file failure yields a null fingerprint.
  const rows = await mapLimit(collected, responsiveBudget(), async (e) => {
    const comp = compressInfo(e.name);
    return [
      e.rel,
      {
        size: e.st.size,
        modified: e.st.mtime.toISOString(),
        created: e.st.birthtime && e.st.birthtimeMs ? e.st.birthtime.toISOString() : null,
        fingerprint: await fingerprint(e.abs, e.st),
        compressible: comp.compressible,
        analysis: analysisOutputs(root, e.rel),
      },
    ] as const;
  });
  const files: Record<string, unknown> = Object.fromEntries(rows);

  fs.mkdirSync(path.join(root, LFBRIDGE_DIR), { recursive: true });
  fs.writeFileSync(filesYamlPath(root), YAML.stringify({ files }), "utf8");
  if (capped) log.warn("storage", `index for ${root} hit the ${MAX_FILES}-file cap — some files not indexed`);
  else log.info("storage", `indexed ${collected.length} large file(s) in ${root}`);
  return collected.length;
}

/** Read `<root>/.lfbridge/files.yaml` into rows (empty when absent). */
export function readStorageIndex(root: string): StorageFileRow[] {
  const p = filesYamlPath(root);
  let doc: { files?: Record<string, Record<string, unknown>> };
  try {
    doc = YAML.parse(fs.readFileSync(p, "utf8")) ?? {};
  } catch {
    return [];
  }
  const files = doc.files ?? {};
  return Object.entries(files).map(([rel, f]) => ({
    path: rel,
    sizeBytes: Number(f.size ?? 0),
    modifiedAt: (f.modified as string) ?? null,
    createdAt: (f.created as string) ?? null,
    fingerprint: (f.fingerprint as string) ?? null,
    compressible: (f.compressible as "video" | "image" | null) ?? null,
    analysis: Array.isArray(f.analysis) ? (f.analysis as string[]) : [],
  }));
}

/** File count from the index without materializing rows; null when the storage was never indexed. */
export function countStorageIndex(root: string): number | null {
  const p = filesYamlPath(root);
  try {
    const doc = YAML.parse(fs.readFileSync(p, "utf8")) ?? {};
    return Object.keys(doc.files ?? {}).length;
  } catch {
    return null;
  }
}
