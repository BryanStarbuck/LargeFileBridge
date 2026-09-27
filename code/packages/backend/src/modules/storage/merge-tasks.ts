// THE HEAVY HALF OF EACH MERGE LEG — a pure function of the files on disk, runnable on ANY thread.
//
// Every shared-document leg of the mirror and the reconcile has the same three parts: a memo check (cheap,
// main thread), the merge itself (multi-megabyte YAML parse → merge → serialize: the part that held the event
// loop for 0.3–3.5 s), and the commit (write + memo, main thread). This module is the middle part ONLY, and
// it is deliberately a LEAF — it imports the pure merge modules and nothing from the service graph — so the
// SAME function runs inline (the synchronous drivers and every test) or in the merge worker thread
// (merge-worker.ts), with no second implementation to drift (performance.mdx P-59).
//
// It never writes. It reports what it read, as file identities taken BEFORE the read, so the commit can
// refuse to write a result computed from bytes that have since moved (a decision clicked while the worker
// was busy must never be overwritten by a merge of the older ledger).
import fs from "node:fs";
import type { DecisionEvent, Manifest, ManifestFile } from "@lfb/shared";
import {
  parseLedgerDetailed,
  parseLedgerBestEffort,
  unionLedgerEvents,
  serializeLedger,
  ledgerMeaning,
  parseLedgerStrict,
  serializeCanonicalLedger,
} from "./ledger-merge.js";
import { parseDeletionsText, emptyDeletions, mergeDeletions, serializeDeletions, deletionsMeaning } from "../pin/deletions-merge.js";
import { mergeManifests, serializeManifest } from "./manifest-merge.js";
import { parseYamlHealingUnionDamage } from "./union-damage.js";
import { normalizeManifestPaths } from "../pin/manifest-normalize.js";
import { canonicalCid } from "../ipfs/cid-canon.js";

/** (inode, size, mtime-ns) — the identity every memo in tracking-sync.service.ts is keyed on. */
export interface FileId {
  ino: string;
  size: string;
  mtimeNs: string;
}

export function fileId(file: string): FileId | null {
  try {
    const st = fs.statSync(file, { bigint: true });
    return { ino: st.ino.toString(), size: st.size.toString(), mtimeNs: st.mtimeNs.toString() };
  } catch {
    return null;
  }
}

/** Same identity — and, unlike the memo's `sameFileId`, two ABSENT files count as the same (a CAS question:
 *  "has anything happened to this path since I looked?", and absent-then-absent is "no"). */
export function sameIdentity(a: FileId | null, b: FileId | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export interface LedgerTask {
  kind: "ledger";
  dstFile: string;
  srcFile: string;
  /** The destination is a SHARED copy: refuse an unreadable one, and apply the semantic write gate. */
  shared: boolean;
}
export interface DeletionsTask {
  kind: "deletions";
  dstFile: string;
  localFile: string;
  mirrorFile: string;
}
export interface ManifestTask {
  kind: "manifest";
  dstFile: string;
  localFile: string;
  mirrorFile: string;
  /** Refuse an unreadable destination (the mirror leg). */
  guard: boolean;
  /** THIS computer's device label — the merge's self-claim rule needs it. */
  selfLabel: string;
  /** Disproved CID → its replacement, canonical on both sides (superseded-cids.service.ts `supersededPairs`). */
  superseded: Record<string, string>;
}
/** Read + strictly parse a decision ledger off the event loop (the decision-click path). */
export interface LedgerReadTask {
  kind: "ledger-read";
  file: string;
}
/** Serialize an already-canonical event list off the event loop (the decision-click path). */
export interface LedgerSerializeTask {
  kind: "ledger-serialize";
  events: DecisionEvent[];
}
export type MergeTask = LedgerTask | DeletionsTask | ManifestTask | LedgerReadTask | LedgerSerializeTask;

/** The identities of the destination and of the OTHER input, taken before either was read. */
export interface ReadIds {
  dst: FileId | null;
  other: FileId | null;
}
export type MergeResult =
  | { outcome: "refuse"; ids: ReadIds }
  | { outcome: "settle"; ids: ReadIds }
  | { outcome: "write"; text: string; ids: ReadIds }
  | { outcome: "error"; message: string }
  /** `ledger-read`: the events, and the file's identity as it was BEFORE the read (null = absent). */
  | { outcome: "events"; events: DecisionEvent[]; id: FileId | null }
  /** `ledger-serialize`: the document text. */
  | { outcome: "text"; text: string };

function ledger(t: LedgerTask): MergeResult {
  const ids = { dst: fileId(t.dstFile), other: fileId(t.srcFile) };
  const dstRaw = readOrNull(t.dstFile);
  const dst = parseLedgerDetailed(dstRaw, t.dstFile);
  // A shared copy we cannot read is not ours to replace (tracking-sync.service.ts `refuseUnparseableMirror`).
  if (t.shared && dst.unreadable) return { outcome: "refuse", ids };
  const merged = unionLedgerEvents(dst.events, parseLedgerBestEffort(readOrNull(t.srcFile), t.srcFile));
  // THE SEMANTIC WRITE GATE (backward_compatibility.md §4.2) — the SHARED direction only. If the merge
  // changes nothing any reader will conclude, the shared copy is left exactly as it is, whatever its bytes:
  // a different order, a compaction an older build does not do, writer stamps an older build stripped,
  // superseded history. Rewriting for any of those is the tug-of-war that turned one stale peer into a
  // commit every few minutes. A DAMAGED copy is the exception — it is written back healed.
  if (t.shared && dstRaw !== null && !dst.damaged && ledgerMeaning(merged) === ledgerMeaning(dst.events)) {
    return { outcome: "settle", ids };
  }
  const text = serializeLedger(merged);
  return text === dstRaw ? { outcome: "settle", ids } : { outcome: "write", text, ids };
}

function deletions(t: DeletionsTask): MergeResult {
  const other = t.dstFile === t.localFile ? t.mirrorFile : t.localFile;
  const ids = { dst: fileId(t.dstFile), other: fileId(other) };
  const readDoc = (f: string) => {
    const raw = readOrNull(f);
    return raw === null ? emptyDeletions() : parseDeletionsText(raw, f);
  };
  let mirrorDoc, localDoc;
  try {
    mirrorDoc = readDoc(t.mirrorFile);
    localDoc = readDoc(t.localFile);
  } catch (e) {
    // An unreadable deletion ledger leaves BOTH copies untouched (deletion.mdx §4) — the caller reports it.
    return { outcome: "error", message: (e as Error).message };
  }
  const merged = mergeDeletions(localDoc, mirrorDoc);
  const dstRaw = readOrNull(t.dstFile);
  // A UNIT WITH NO DELETIONS HAS NO FILE — not an empty list (deletion.mdx §4).
  if (merged.deletions.length === 0 && dstRaw === null) return { outcome: "settle", ids };
  // The semantic write gate, as for the ledger (backward_compatibility.md §4.2): twins, order and stripped
  // writer stamps are spelling, not meaning, and the shared copy is not rewritten for spelling.
  if (t.dstFile === t.mirrorFile && dstRaw !== null && deletionsMeaning(merged) === deletionsMeaning(mirrorDoc)) {
    return { outcome: "settle", ids };
  }
  const text = serializeDeletions(merged);
  return text === dstRaw ? { outcome: "settle", ids } : { outcome: "write", text, ids };
}

/**
 * Read a manifest, healing line-union damage, and say whether it could be read at all. Moved here from
 * tracking-sync.service.ts unchanged, so the worker and the event loop read a manifest identically.
 */
export function readManifestChecked(file: string, unit: Manifest["unit"]): { manifest: Manifest; unreadable: boolean } {
  const empty: Manifest = { schema_version: 1, unit, files: [] };
  const raw = readOrNull(file);
  if (raw === null || !raw.trim()) return { manifest: empty, unreadable: false }; // absent — nothing to protect
  try {
    if (raw.includes("<<<<<<<")) return { manifest: empty, unreadable: true }; // conflict markers — half-merged
    // Heal line-union damage before judging the document unreadable — `manifest.yaml` carries the same
    // `merge=union` attribute as the ledger and fails the same way (union-damage.ts).
    const parsed = parseYamlHealingUnionDamage(raw).doc as Partial<Manifest> | null;
    if (!parsed || !Array.isArray(parsed.files)) return { manifest: empty, unreadable: true };
    // Same POSIX-separator heal as the primary reader (manifest.service.ts): a Windows peer's mirrored
    // copy carries `\` paths, and merging those unnormalized would re-introduce duplicate spellings of
    // the same file into Local Storage on every reconcile.
    return {
      manifest: normalizeManifestPaths(
        { schema_version: parsed.schema_version ?? 1, unit: parsed.unit ?? unit, files: parsed.files as ManifestFile[] },
        file,
      ),
      unreadable: false,
    };
  } catch {
    return { manifest: empty, unreadable: true }; // not YAML at all
  }
}

function manifest(t: ManifestTask): MergeResult {
  const other = t.dstFile === t.localFile ? t.mirrorFile : t.localFile;
  const ids = { dst: fileId(t.dstFile), other: fileId(other) };
  const localRead = readManifestChecked(t.localFile, "repo");
  const mirrorRead = readManifestChecked(t.mirrorFile, "repo");
  if (t.guard && (t.dstFile === t.localFile ? localRead : mirrorRead).unreadable) return { outcome: "refuse", ids };
  const merged = mergeManifests(localRead.manifest, mirrorRead.manifest, t.selfLabel, {
    incomingIsWire: true, // the mirror is the SHARED copy — a peer's claim is ITS statement, not ours
    // …but a wrapper CID we PROVED wrong must never ride back in from either side. The same lookup
    // `supersededCid` does, over a snapshot of the map taken on the main thread.
    supersededCid: (cid) => t.superseded[canonicalCid(cid)] ?? null,
  });
  const text = serializeManifest(merged);
  return text === readOrNull(t.dstFile) ? { outcome: "settle", ids } : { outcome: "write", text, ids };
}

/** Run one task to completion on the current thread. Never throws — a fault is a result. */
export function runMergeTask(t: MergeTask): MergeResult {
  try {
    switch (t.kind) {
      case "ledger":
        return ledger(t);
      case "deletions":
        return deletions(t);
      case "manifest":
        return manifest(t);
      case "ledger-read": {
        const id = fileId(t.file);
        const raw = readOrNull(t.file);
        if (raw === null) return { outcome: "events", events: [], id: null };
        const r = parseLedgerStrict(raw);
        // A ledger the strict reader would REFUSE is not the worker's to judge: the caller falls back to the
        // synchronous reader, which quarantines and reports exactly as it always has.
        return r.ok ? { outcome: "events", events: r.events, id } : { outcome: "error", message: r.message };
      }
      case "ledger-serialize":
        return { outcome: "text", text: serializeCanonicalLedger(t.events) };
    }
  } catch (e) {
    return { outcome: "error", message: (e as Error).message };
  }
}
