// The COMPRESSED-STATE LEDGER (compression.mdx §8.4) — "have we already dealt with this file?", answered
// across every computer in the mesh.
//
// THE RULE IT ENFORCES: a file is compressed AT MOST ONCE. Ever. Re-compressing is not merely wasted CPU —
// for a lossy target it is a fresh generation of loss stacked on the last one, which is how a screenshot
// ends up smeared after a few sweeps. So before any transcode we ask three independent sources, and ANY of
// them saying "done" stops the work:
//
//   1. THE IN-FILE MARKER (compress-marker.ts) — written into the file's own container. Travels with the
//      bytes anywhere, needs no shared state. This is the strongest signal, but not every format can hold
//      one (and a file compressed by a tool other than us never will).
//   2. THIS COMPUTER'S LOCAL STORAGE record — `~/T/_large_files_bridge/repos/<repoKey>/analysis/<rel>/
//      compression.yaml`. Category-B tracking state; never enters a working repo.
//   3. THE TRAVELLING record in the owning company / Personal SYNC REPO —
//      `<syncRepo>/repos/<repoUid>/analysis/<rel>/compression.yaml`. This is the one that answers the case
//      the user actually hits: the file was compressed on ANOTHER computer, the compressed bytes arrived
//      here over IPFS or git, and — if the format could not carry a marker — nothing in the bytes says so.
//      The record came across in the sync repo, so this machine still knows, and still refuses to redo it.
//
// WHY WE ALSO RECORD REFUSALS
// The old engine recorded only successes. So a file we deliberately declined — "the only candidate was 1.4%
// smaller, keep the original" — carried no memory of that decision, and every later sweep paid the full
// transcode again to reach the identical conclusion. Every terminal outcome is now recorded, including
// `declined`, and a declined file is not re-offered while its bytes are unchanged.
//
// FRESHNESS: a record describes SPECIFIC BYTES. It is honoured only while the file still has the size the
// record captured; edit or replace the file and the record stops applying and the file is offered again.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { CompressionRecord, CompressionOutcome } from "@lfb/shared";
import { repoStateDir, resolveStateSyncRepo } from "../storage/tracking-root.service.js";
import { trackingBaseDir, legacyTrackingBaseDir } from "../storage/storage-type.service.js";
import { log } from "../../shared/logging.js";
import { sizeOrNull, isFileAt } from "../../shared/fs-probe.js";

const ANALYSIS_DIR = "analysis";
const RECORD_FILE = "compression.yaml";

/** Every directory a compression record for `<root>/<rel>` can legitimately live in, most-authoritative
 *  first. The first two are the ones this app writes today; the rest are read-only compatibility with
 *  records written by older versions (and by an SDL that has not been migrated yet), because a record we
 *  fail to find is a file we needlessly re-compress. */
function recordDirs(root: string, rel: string): string[] {
  const dirs = [path.join(repoStateDir(root), ANALYSIS_DIR, rel)];
  try {
    const sync = resolveStateSyncRepo(root);
    if (sync) dirs.push(path.join(sync, ANALYSIS_DIR, rel));
  } catch {
    /* no sync repo configured → Local-Storage-only */
  }
  try {
    dirs.push(path.join(trackingBaseDir(root), ANALYSIS_DIR, rel));
    const legacy = legacyTrackingBaseDir(root);
    if (legacy) dirs.push(path.join(legacy, ANALYSIS_DIR, rel));
  } catch {
    /* a root whose type cannot be resolved simply has fewer places to look */
  }
  return dirs;
}

/** The record as it sits on disk, plus which file it came from (for the log line). */
export interface LedgerHit {
  record: CompressionRecord;
  from: string;
}

/**
 * Look the file up in the ledger. Returns the FIRST fresh record found, or null.
 *
 * "Fresh" = the record's recorded post-compression size equals the file's size right now. A record whose
 * size no longer matches describes bytes that are gone, so it is ignored (and the file becomes eligible
 * again) rather than trusted — that is what lets a genuinely re-edited file be compressed a second time
 * without ever letting an UNCHANGED file be compressed twice.
 */
export function readLedger(root: string, rel: string): LedgerHit | null {
  const mediaAbs = path.join(root, rel);
  // Non-throwing (shared/fs-probe): readLedger is asked per file across whole trees.
  const currentSize = sizeOrNull(mediaAbs);
  if (currentSize === null) return null; // media gone → nothing to protect
  for (const dir of recordDirs(root, rel)) {
    const file = path.join(dir, RECORD_FILE);
    let rec: CompressionRecord | null = null;
    try {
      if (!isFileAt(file)) continue; // non-throwing — most files have no record at all
      rec = YAML.parse(fs.readFileSync(file, "utf8")) as CompressionRecord | null;
    } catch {
      continue; // unreadable record → keep looking; never claim "done" on one we could not parse
    }
    if (!rec) continue;
    const recSize = rec.compressed?.size;
    // A record without a size predates the size field. Trust it — it is still a positive statement that
    // this app already handled the file, and re-compressing on a doubt is the failure mode we are here to
    // prevent.
    if (recSize != null && recSize !== currentSize) continue;
    return { record: rec, from: file };
  }
  return null;
}

/** Does the ledger say this file is finished — either compressed, or deliberately declined? */
export function ledgerSaysDone(root: string, rel: string): LedgerHit | null {
  const hit = readLedger(root, rel);
  if (!hit) return null;
  const outcome: CompressionOutcome = hit.record.outcome ?? "compressed";
  return outcome === "compressed" || outcome === "declined" ? hit : null;
}

/**
 * Write the travelling compression record to LOCAL STORAGE (`repos/<repoKey>/analysis/<rel>/`).
 *
 * Local Storage is the only write target on purpose (artifact_placement_policy.mdx §2): it never touches
 * git, so it can never merge-conflict. The copy in the company / Personal sync repo — the one that reaches
 * the user's OTHER computers — is produced from here by tracking-sync.service.ts `mirrorToSyncRepo`, which
 * mirrors the whole state dir. So one write lands in both places the charter asks for, and neither can
 * conflict.
 *
 * Best-effort by contract: the caller has usually already replaced the bytes by the time this runs, so a
 * failure here must surface as a warning, never as a failed compression.
 */
export function writeLedger(root: string, rel: string, record: CompressionRecord): void {
  try {
    const dir = path.join(repoStateDir(root), ANALYSIS_DIR, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, RECORD_FILE), YAML.stringify(record), "utf8");
  } catch (e) {
    log.warn("compress", `compression record not written for ${rel}: ${(e as Error).message}`);
  }
}

/** Build the record for a terminal outcome. Kept in one place so every call site records the same shape —
 *  the `declined` path is exactly as much of a record as the `compressed` one, which is the whole point. */
export function buildRecord(args: {
  rel: string;
  originalName: string;
  originalExt: string;
  originalSize: number;
  outcome: CompressionOutcome;
  codec: string | null;
  size: number;
  /** Why we stopped, for `declined` (surfaced in the UI so a skip reads as a decision, not a failure). */
  reason?: string | null;
  /** The chroma sampling the output carries, e.g. "1x1,1x1,1x1" — the auditable proof of the 4:4:4 rule. */
  chroma?: string | null;
  /** Was the transform provably pixel-identical? */
  lossless?: boolean;
  /** The engine that produced it, e.g. "mozjpeg q92 4:4:4". */
  engine?: string | null;
}): CompressionRecord {
  return {
    source: args.rel,
    original: { name: args.originalName, extension: args.originalExt, size: args.originalSize },
    compressed: {
      codec: args.codec,
      size: args.size,
      ratio: args.originalSize > 0 ? Number((args.size / args.originalSize).toFixed(3)) : 0,
      at: new Date().toISOString(),
    },
    outcome: args.outcome,
    reason: args.reason ?? null,
    chroma: args.chroma ?? null,
    lossless: args.lossless ?? false,
    engine: args.engine ?? null,
    markerVersion: 2,
  };
}
