// Per-file media analysis (storages.mdx §6). Writes the analysis outputs as YAML under
// `<storage root>/.lfbridge/analysis/<relpath>/`:
//   * transcript.yaml       — speech-to-text with time ranges (video + audio)
//   * description.yaml       — video summary / image contents (all visual/audible media)
//   * visuals_by_time.yaml   — time ranges × what's visually going on × story (video)
//
// The actual transcription/vision engine is a later integration; this writes the structured skeletons
// with status "pending" so the outputs, layout, and caching-by-presence are in place now. Node fs only.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { mediaKindForName } from "@lfb/shared";
import { log } from "../../shared/logging.js";

const LFBRIDGE_DIR = ".lfbridge";
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
 * supports. Returns which outputs were written. Throws when the target isn't a media file.
 */
export function analyzeFile(root: string, rel: string): string[] {
  const abs = path.join(root, rel);
  if (!isFile(abs)) throw new Error("analyze: target must be an existing file");
  const kind = mediaKindForName(path.basename(rel)); // "image" | "video" | "audio" | null
  if (!kind) throw new Error("analyze: not a media file (video / audio / image)");

  const outDir = path.join(root, LFBRIDGE_DIR, ANALYSIS_DIR, rel);
  fs.mkdirSync(outDir, { recursive: true });
  const outputs: string[] = [];
  const base = { source: rel, status: "pending" as const, engine: null, generated: null };

  // Transcript — what people are saying (video + audio).
  if (kind === "video" || kind === "audio") {
    writeYaml(path.join(outDir, "transcript.yaml"), { ...base, segments: [] });
    outputs.push("transcript");
  }
  // Description — video summary / image contents (every media kind).
  writeYaml(path.join(outDir, "description.yaml"), { ...base, description: null });
  outputs.push("description");
  // Visuals & action by time — video only.
  if (kind === "video") {
    writeYaml(path.join(outDir, "visuals_by_time.yaml"), { ...base, segments: [] });
    outputs.push("visuals_by_time");
  }

  log.info("storage", `analysis queued (${outputs.join(", ")}) for ${rel} in ${root}`);
  return outputs;
}
