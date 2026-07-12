// `history/<device>.txt` — the per-computer audit log (repo_tracking_scheme.mdx §4). One plain-text,
// UTC-timestamped log PER COMPUTER of every decision and automatic action, named by this computer's unique
// device name (devices.mdx). Same self-owned-file trust model as the device registry: a computer appends
// ONLY to its own file, so two machines never contend on the same log. Git-ignored WORKING artifact, gated
// on the keep-`.lfbridge/` consent. This is a legible MIRROR of the committed decisions.yaml / the sidecars
// — not the source of truth (§4.1).
import fs from "node:fs";
import path from "node:path";
import { LFBRIDGE_DIR } from "./tracking.service.js";
import { storageSid } from "./storage.service.js";
import { readStorageSettings } from "./storage-settings.service.js";
import { selfDeviceName } from "./devices.service.js";
import { repoFolderKey } from "../../shared/store/sanitize.js";
import { log } from "../../shared/logging.js";

// ── paths + consent (same pattern as decisions.service.ts) ─────────────────────

function trackingDir(repoRoot: string): string {
  try {
    const relocated = readStorageSettings(storageSid(repoRoot)).lfbridge.path;
    if (relocated && relocated.trim()) return path.resolve(relocated);
  } catch {
    /* no per-storage settings yet → default location */
  }
  return path.join(repoRoot, LFBRIDGE_DIR);
}

function keepsLfbridge(repoRoot: string): boolean {
  try {
    return readStorageSettings(storageSid(repoRoot)).lfbridge.enabled;
  } catch {
    return true; // documented default: keep .lfbridge/
  }
}

/** The history-log path for a device name — `.lfbridge/history/<sanitized-device>.txt` (sanitized the same
 *  way device-registry filenames are, so the two agree). Honors a relocated `.lfbridge/`. */
export function historyPath(repoRoot: string, deviceName: string): string {
  return path.join(trackingDir(repoRoot), "history", `${repoFolderKey(deviceName)}.txt`);
}

/** One file's per-action outcome, for the indented breakdown when a multi-file action differs per file. */
export interface HistoryPerFile {
  axis: string; // e.g. "pin", "gitignore", "compress"
  value: string; // e.g. "yes" / "no"
  path: string; // repo-relative
}

/** One history entry (repo_tracking_scheme.mdx §4.1). `verb` is the event kind (SCAN, DECISION, IPFS-PIN,
 *  IPFS-UNPIN, COMPRESS, CONVERT, TRANSCRIBE, PULL, OBSERVED); `fields` become `key=value` segments. */
export interface HistoryEntry {
  verb: string;
  by?: string | null; // allow-listed email, or the not-lfbridge sentinel; omitted when absent
  fields?: Record<string, string | number | boolean>; // extra key=value segments (e.g. headless=false)
  summary: string;
  perFile?: HistoryPerFile[]; // indented per-file breakdown when outcomes differ
}

const PERFILE_INDENT = " ".repeat(24); // aligns the per-file lines under the summary (§4.1 example)

/**
 * Append a UTC-stamped entry to THIS computer's own history log for the repo (repo_tracking_scheme.mdx §4).
 * Resolves this computer's unique device name via devices.service and writes ONLY to its own file. Line
 * shape: `<UTC>␠␠<VERB>␠␠<key=value …>␠␠<summary>`; when `perFile` outcomes differ, an indented
 * `<axis>=<value>␠␠<path>` line follows per file. Gated on the keep-`.lfbridge/` consent — with consent
 * off, writes NOTHING into the repo root.
 */
export function appendHistory(repoRoot: string, entry: HistoryEntry): void {
  if (!keepsLfbridge(repoRoot)) return; // consent off → never touch the repo root
  const deviceName = selfDeviceName();
  const file = historyPath(repoRoot, deviceName);
  const stamp = new Date().toISOString();

  const segments = [stamp, entry.verb];
  if (entry.by) segments.push(`by=${entry.by}`);
  for (const [k, v] of Object.entries(entry.fields ?? {})) segments.push(`${k}=${v}`);
  segments.push(entry.summary);

  let block = segments.join("  ") + "\n";
  for (const pf of entry.perFile ?? []) {
    block += `${PERFILE_INDENT}${pf.axis}=${pf.value}  ${pf.path}\n`;
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A brand-new log opens with a legible header (§4.1) identifying the computer + repo.
    if (!fs.existsSync(file)) {
      const header =
        `# Large File Bridge — history log for computer "${deviceName}" · repo ${path.basename(repoRoot)}\n` +
        `# All timestamps UTC. Append-only. One line per event; indented block when files differ.\n`;
      fs.appendFileSync(file, header, "utf8");
    }
    fs.appendFileSync(file, block, "utf8");
  } catch (e) {
    log.error("storage", `history append failed: ${file}: ${(e as Error).message}`);
  }
}
