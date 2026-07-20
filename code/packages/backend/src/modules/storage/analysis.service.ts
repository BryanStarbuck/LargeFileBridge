// Per-file media analysis (storages.mdx §6). Writes the analysis outputs that still live as YAML under the
// storage's TRACKING BASE — `<root>/.lfbridge/analysis/<relpath>/` in a working repo, `<root>/analysis/<relpath>/`
// in an SDL, which has no `.lfbridge/` (artifact_placement_policy.mdx §0):
//   * visuals_by_time.yaml   — time ranges × what's visually going on × story (video)
//
// Transcript and description are NO LONGER skeletoned here — they are SIDECARS beside the media
// (<rel-without-ext>.transcription / .ai_description), written directly by transcribe.service /
// describe.service as self-contained `done` records (Transcribe.mdx §3, ai_description.mdx §2). The
// visuals-by-time engine is a later integration; this writes its structured skeleton with status
// "pending" so the output, layout, and caching-by-presence are in place now. Node fs only.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { mediaKindForName, type CompressionRecord } from "@lfb/shared";
import { log } from "../../shared/logging.js";

import { trackingBaseDir } from "./storage-type.service.js";
import { resolveTrackingRoot } from "./tracking-root.service.js";

const ANALYSIS_DIR = "analysis";

function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function writeYaml(file: string, data: unknown): void {
  fs.writeFileSync(file, YAML.stringify(data), "utf8");
}

/**
 * Queue analysis for one file in a storage: write the skeleton YAML(s) for the outputs its media kind
 * supports. Transcript + description are NOT written here anymore — those are sidecars produced by their
 * own actions; only the video-only visuals-by-time skeleton remains. Returns which outputs were written.
 * Throws when the target isn't a media file.
 */
export function analyzeFile(root: string, rel: string): string[] {
  const abs = path.join(root, rel);
  if (!isFile(abs)) throw new Error("analyze: target must be an existing file");
  const kind = mediaKindForName(path.basename(rel)); // "image" | "video" | "audio" | null
  if (!kind) throw new Error("analyze: not a media file (video / audio / image)");

  const outputs: string[] = [];
  const base = { source: rel, status: "pending" as const, engine: null, generated: null };

  // Visuals & action by time — video only. Transcript/description are sidecars (see file header).
  if (kind === "video") {
    const outDir = path.join(trackingBaseDir(root), ANALYSIS_DIR, rel);
    fs.mkdirSync(outDir, { recursive: true });
    writeYaml(path.join(outDir, "visuals_by_time.yaml"), { ...base, segments: [] });
    outputs.push("visuals_by_time");
  }

  log.info("storage", `analysis queued (${outputs.join(", ") || "none"}) for ${rel} in ${root}`);
  return outputs;
}

/**
 * Write the travelling compression record for a file (compression.mdx §8 step 6) —
 * `<Local Storage repos/<repoKey>>/analysis/<relpath>/compression.yaml`. It is CATEGORY-B tracking state
 * (artifact_placement_policy.mdx): Local Storage ALWAYS, never the working repo — matching its two sibling
 * writes (the files.yaml entry and the per-file sidecar `compress` event, both already Local-Storage) and
 * travelling to the user's other computers via the sync-repo mirror (tracking-sync.service.ts
 * `mirrorToSyncRepo`, which copies the whole state dir). Captures what the file WAS before compression
 * (original name/extension + size) and the after (codec/size/ratio/at) so every computer that carries the
 * storage knows the file was compressed, from what, and by how much — without re-deriving anything.
 * Read back by tracking.service.ts `analysisOutputs` ("compression" signal → the Compress task status).
 */
export function writeCompressionRecord(root: string, rel: string, record: CompressionRecord): void {
  const outDir = path.join(resolveTrackingRoot(root), ANALYSIS_DIR, rel);
  fs.mkdirSync(outDir, { recursive: true });
  writeYaml(path.join(outDir, "compression.yaml"), {
    source: record.source,
    original: {
      name: record.original.name,
      extension: record.original.extension,
      size: record.original.size,
    },
    compressed: {
      codec: record.compressed.codec,
      size: record.compressed.size,
      ratio: record.compressed.ratio,
      at: record.compressed.at,
    },
  });
  log.info("storage", `compression record written for ${rel} in ${root}`);
}
