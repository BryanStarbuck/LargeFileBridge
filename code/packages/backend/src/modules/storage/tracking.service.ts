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

/** A cheap-but-robust fingerprint: hash of size + mtime + the head and tail bytes. */
function fingerprint(abs: string, st: fs.Stats): string | null {
  try {
    const h = crypto.createHash("sha256");
    h.update(String(st.size));
    h.update(String(Math.round(st.mtimeMs)));
    const fd = fs.openSync(abs, "r");
    try {
      const headLen = Math.min(FINGERPRINT_CHUNK, st.size);
      const head = Buffer.alloc(headLen);
      fs.readSync(fd, head, 0, headLen, 0);
      h.update(head);
      if (st.size > FINGERPRINT_CHUNK) {
        const tailLen = Math.min(FINGERPRINT_CHUNK, st.size);
        const tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, Math.max(0, st.size - tailLen));
        h.update(tail);
      }
    } finally {
      fs.closeSync(fd);
    }
    return h.digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

/** (Re)build `<root>/.lfbridge/files.yaml` from the large files under the storage. Returns the count. */
export function indexStorageFiles(root: string): number {
  const threshold = getAppConfig().big_file.threshold_bytes;
  const files: Record<string, unknown> = {};
  let count = 0;

  const walk = (dir: string): void => {
    if (count >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (count >= MAX_FILES) break;
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
      const rel = path.relative(root, abs);
      const comp = compressInfo(name);
      files[rel] = {
        size: st.size,
        modified: st.mtime.toISOString(),
        created: st.birthtime && st.birthtimeMs ? st.birthtime.toISOString() : null,
        fingerprint: fingerprint(abs, st),
        compressible: comp.compressible,
        analysis: analysisOutputs(root, rel),
      };
      count++;
    }
  };
  walk(root);

  fs.mkdirSync(path.join(root, LFBRIDGE_DIR), { recursive: true });
  fs.writeFileSync(filesYamlPath(root), YAML.stringify({ files }), "utf8");
  if (count >= MAX_FILES) log.warn("storage", `index for ${root} hit the ${MAX_FILES}-file cap — some files not indexed`);
  else log.info("storage", `indexed ${count} large file(s) in ${root}`);
  return count;
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
