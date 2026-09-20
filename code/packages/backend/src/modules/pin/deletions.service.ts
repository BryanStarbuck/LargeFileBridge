// FLEET-WIDE DELETION — the tombstone ledger and the reaper (pm/deletion.mdx).
//
// WHAT THIS IS FOR. Every other mechanism in this product exists to make a file COME BACK. That is the
// right default and it is not changing — which is what makes deletion a feature that has to be built
// deliberately, because it is the one act the rest of the system is actively working to undo.
//
// THE DEFECT IT FIXES (deletion.mdx §1, measured 2026-09-19/20). Ten images of a private individual were
// deleted from a repo and from disk, and the pin pass re-downloaded them EVERY HOUR for a day. Nothing was
// broken: `orphans.service.ts` tells "deleted here" from "never here" using this computer's own label in
// `pinned_by`, and the computer doing the deleting was not in that list — so absence classified as the
// healthy "never here", and `fetchMissing` did exactly its job. The old delete was asked a question it had
// no way to answer. A per-computer delete can never say "this file should not exist anywhere."
//
// So a tombstone is:
//   * EXPLICIT — always asked for out loud, never inferred from a filesystem observation. That is the one
//     fact that separates it from a user reclaiming disk space, which must never escalate to fleet-wide
//     destruction (deletion.mdx §2).
//   * EXPRESSIBLE FROM ANY DEVICE — including one that never held the file. That is the §1 case.
//   * TRAVELLING — it rides the git backbone beside manifest.yaml, so every device enforces it.
//   * A GATE, not another input — it is applied BEFORE every path that can materialize bytes. A delete
//     that merely competes with the re-fetch engines loses to them.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import { DeletionsSchema, type Deletions, type DeletionRecord, type ManifestFile } from "@lfb/shared";
import { resolveTrackingRoot, resolveStateSyncRepo } from "../storage/tracking-root.service.js";
import { joinRelConfined } from "../../shared/rel-path.js";
import { log } from "../../shared/logging.js";

/** `<trackingRoot>/deletions.yaml` — beside manifest.yaml, Category B, never in the working repo. */
export function deletionsPathForRepo(repoRoot: string): string {
  return path.join(resolveTrackingRoot(repoRoot), "deletions.yaml");
}

export function emptyDeletions(): Deletions {
  return { schema_version: 1, unit: "repo", deletions: [] };
}

/** True if the raw text carries git merge-conflict markers (repo__list_syns.mdx §5.1). */
function hasConflictMarkers(raw: string): boolean {
  return /^(<{7}|={7}|>{7})(\s|$)/m.test(raw);
}

/**
 * Read a ledger. A MISSING FILE IS AN EMPTY LEDGER — that is the only absence in this feature that means
 * anything (deletion.mdx §4).
 *
 * A HALF-MERGED file REFUSES to load, exactly as the manifest does. Parsing one would be worse here than
 * anywhere else in the product: the plausible failure is silently dropping records, and a dropped
 * tombstone puts a deleted file back on every computer.
 */
export function readDeletions(file: string): Deletions {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return emptyDeletions();
  }
  if (hasConflictMarkers(raw)) {
    throw new Error(`deletions.yaml is half-merged (conflict markers): ${file} — resolve it before syncing`);
  }
  try {
    return DeletionsSchema.parse(YAML.parse(raw) ?? {});
  } catch (e) {
    throw new Error(`deletions.yaml is unreadable: ${file} — ${(e as Error).message}`);
  }
}

/** Deterministic, byte-stable serialization — same contract as the manifest (repo__list_syns.mdx §6). */
export function serializeDeletions(d: Deletions): string {
  return YAML.stringify({
    schema_version: d.schema_version,
    unit: d.unit,
    deletions: [...d.deletions]
      .sort((a, b) => a.path.localeCompare(b.path) || (a.removed_at ?? "").localeCompare(b.removed_at ?? ""))
      .map((r) => ({
        path: r.path,
        cid: r.cid,
        cid_alternates: [...r.cid_alternates].sort((a, b) => a.localeCompare(b)),
        sha256: r.sha256,
        size: r.size,
        scope: r.scope,
        reason: r.reason,
        removed_at: r.removed_at,
        removed_by: r.removed_by,
        removed_on_device: r.removed_on_device,
        actions: { delete_bytes: r.actions.delete_bytes, unpin: r.actions.unpin },
        enforced_by: [...r.enforced_by].sort((a, b) => a.device.localeCompare(b.device)),
        undeleted_at: r.undeleted_at,
        undeleted_by: r.undeleted_by,
        undelete_reason: r.undelete_reason,
      })),
  });
}

export function writeDeletions(file: string, d: Deletions): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = serializeDeletions(d);
  // Byte-compare before writing: an unchanged ledger must not move its mtime or produce a noise commit on
  // the backbone. Every pin pass on every device calls through here.
  try {
    if (fs.readFileSync(file, "utf8") === next) return;
  } catch {
    /* absent — write it */
  }
  fs.writeFileSync(file, next);
}

/** The identity key a record folds on (deletion.mdx §6): union by (path, cid, sha256). */
function identityKey(r: DeletionRecord): string {
  return `${r.path}\u0000${r.cid ?? ""}\u0000${r.sha256 ?? ""}`;
}

/**
 * MERGE TWO LEDGERS (deletion.mdx §6). Union by identity; `enforced_by` and `cid_alternates` union;
 * WIDEST SCOPE wins (`fleet` beats `here`); MOST DESTRUCTIVE `actions` win (`true` beats `false`).
 *
 * That last rule is the ONE place in this product where conflict resolution deliberately does not preserve
 * data, and it is correct precisely here: the cost of over-deleting is an `undelete`, and the cost of
 * under-deleting is a private individual's photograph back on a public website.
 *
 * ABSENCE NEVER LIFTS A TOMBSTONE. An incoming ledger that is empty, truncated, mid-transfer, or written
 * by an older build that never knew about the file removes NOTHING — this function only ever adds.
 */
export function mergeDeletions(mine: Deletions, theirs: Deletions): Deletions {
  const by = new Map<string, DeletionRecord>();
  for (const r of [...mine.deletions, ...theirs.deletions]) {
    const k = identityKey(r);
    const prior = by.get(k);
    if (!prior) {
      by.set(k, { ...r, cid_alternates: [...r.cid_alternates], enforced_by: [...r.enforced_by] });
      continue;
    }
    const receipts = new Map(prior.enforced_by.map((e) => [e.device, e]));
    for (const e of r.enforced_by) {
      const had = receipts.get(e.device);
      // Newest receipt per device wins — a device that re-enforced later is reporting the current truth.
      if (!had || (e.at ?? "") > (had.at ?? "")) receipts.set(e.device, e);
    }
    // An undelete is honoured only when it is NEWER than the deletion it lifts. An older undelete arriving
    // late must not resurrect a file that was deliberately deleted again afterwards.
    const undeleteWins =
      (prior.undeleted_at ?? r.undeleted_at) !== null &&
      (() => {
        const un = [prior.undeleted_at, r.undeleted_at].filter(Boolean).sort().at(-1) as string;
        const del = [prior.removed_at, r.removed_at].filter(Boolean).sort().at(-1) as string;
        return un > del;
      })();
    const newer = (r.removed_at ?? "") > (prior.removed_at ?? "") ? r : prior;
    by.set(k, {
      ...newer,
      cid_alternates: [...new Set([...prior.cid_alternates, ...r.cid_alternates])],
      sha256: prior.sha256 ?? r.sha256,
      cid: prior.cid ?? r.cid,
      scope: prior.scope === "fleet" || r.scope === "fleet" ? "fleet" : "here",
      actions: {
        delete_bytes: prior.actions.delete_bytes || r.actions.delete_bytes,
        unpin: prior.actions.unpin || r.actions.unpin,
      },
      enforced_by: [...receipts.values()],
      undeleted_at: undeleteWins ? ([prior.undeleted_at, r.undeleted_at].filter(Boolean).sort().at(-1) as string) : null,
      undeleted_by: undeleteWins ? (prior.undeleted_by ?? r.undeleted_by) : null,
      undelete_reason: undeleteWins ? (prior.undelete_reason ?? r.undelete_reason) : null,
    });
  }
  return { schema_version: 1, unit: mine.unit ?? theirs.unit ?? "repo", deletions: [...by.values()] };
}

/** A tombstone is LIVE when it has not been undeleted and it applies to this device. */
export function isLive(r: DeletionRecord, thisDevice: string): boolean {
  if (r.undeleted_at) return false;
  return r.scope === "fleet" || r.removed_on_device === thisDevice;
}

// ── The match index (deletion.mdx §5) ───────────────────────────────────────
// A manifest entry is tombstoned when ANY of CID / sha256 / path matches — not all three. Requiring
// agreement would mean a re-add under a new CID, or a move to a new path, walks straight through the gate.
//
// CID matching is NOT optional. The same bytes are routinely tracked twice: the original under
// `~/_Mirror/.../1Robbie_Parker_.jpg` and the site's served copy at `.../evidence/<sha256>.jpg`. Two paths,
// one set of bytes. A path-only tombstone deletes the second and lets the first re-seed it.

export interface TombstoneIndex {
  byCid: Map<string, DeletionRecord>;
  bySha: Map<string, DeletionRecord>;
  byPath: Map<string, DeletionRecord>;
  size: number;
}

export function buildTombstoneIndex(
  d: Deletions,
  thisDevice: string,
  canonicalCid: (c: string) => string,
): TombstoneIndex {
  const byCid = new Map<string, DeletionRecord>();
  const bySha = new Map<string, DeletionRecord>();
  const byPath = new Map<string, DeletionRecord>();
  let size = 0;
  for (const r of d.deletions) {
    if (!isLive(r, thisDevice)) continue;
    size++;
    for (const c of [r.cid, ...r.cid_alternates]) {
      if (!c) continue;
      try {
        byCid.set(canonicalCid(c), r);
      } catch {
        byCid.set(c, r);
      }
    }
    if (r.sha256) bySha.set(r.sha256.toLowerCase(), r);
    if (r.path) byPath.set(toRelPosix(r.path), r);
  }
  return { byCid, bySha, byPath, size };
}

export function toRelPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

/** THE ONE PREDICATE every caller shares (deletion.mdx §7.1). A gate with a second door is not a gate. */
export function matchTombstone(
  idx: TombstoneIndex,
  entry: { path: string; cid?: string | null; sha256?: string | null },
  canonicalCid: (c: string) => string,
): DeletionRecord | null {
  if (idx.size === 0) return null;
  if (entry.cid) {
    let c = entry.cid;
    try {
      c = canonicalCid(entry.cid);
    } catch {
      /* use raw */
    }
    const hit = idx.byCid.get(c);
    if (hit) return hit;
  }
  if (entry.sha256) {
    const hit = idx.bySha.get(entry.sha256.toLowerCase());
    if (hit) return hit;
  }
  return idx.byPath.get(toRelPosix(entry.path)) ?? null;
}

// ── The reaper (deletion.mdx §7.2) ──────────────────────────────────────────

export interface ReapDeps {
  /** Resolve a unit-relative path to this computer's absolute path, or null when not placeable here. */
  resolveAbs: (rel: string) => string | null;
  /** Content-aware "does this node hold these bytes?" — a foreign add profile still counts. */
  pinsetHasContent: (cid: string) => boolean;
  pinRm: (cid: string) => Promise<void>;
  canonicalCid: (c: string) => string;
  /** This computer's `pinned_by` label. */
  label: string;
  /** The unit's manifest entries, keyed by unit-relative path — mutated in place. */
  byPath: Map<string, ManifestFile>;
  /** Return a decided file to Undecided so it stops sitting in the queue asking to be re-synced. */
  tombstoneDecision?: (rels: string[]) => Promise<void>;
  /** Where derived sidecars for this path live, if anywhere. */
  sidecarPathsFor?: (rel: string) => string[];
}

export interface ReapResult {
  bytesDeleted: number;
  unpinned: number;
  sidecarsRemoved: number;
  entriesMarked: number;
  /** Paths the ledger changed for — the caller writes the ledger back once. */
  touched: string[];
}

/**
 * Enforce every live tombstone against this unit, on this device. IDEMPOTENT: a pass over an
 * already-enforced tombstone does nothing and reports nothing.
 *
 * Each step is independent of the last SUCCEEDING. A pin that will not drop must not stop the bytes being
 * deleted, and bytes that will not delete must not stop the claim being retracted — partial enforcement
 * that reports itself honestly beats all-or-nothing that silently leaves the file in place.
 */
export async function reap(d: Deletions, deps: ReapDeps, nowIso: string): Promise<ReapResult> {
  const out: ReapResult = { bytesDeleted: 0, unpinned: 0, sidecarsRemoved: 0, entriesMarked: 0, touched: [] };
  const staled: string[] = [];

  for (const r of d.deletions) {
    if (!isLive(r, deps.label)) continue;

    // Which manifest entries does this tombstone actually claim here? Match by CONTENT as well as path, so
    // the same bytes tracked under a second name in this unit are caught too (§5.1).
    const targets: ManifestFile[] = [];
    for (const e of deps.byPath.values()) {
      let ec = e.cid ?? "";
      if (ec) {
        try {
          ec = deps.canonicalCid(ec);
        } catch {
          /* raw */
        }
      }
      const cidHit =
        !!ec && [r.cid, ...r.cid_alternates].filter(Boolean).some((c) => {
          try {
            return deps.canonicalCid(c as string) === ec;
          } catch {
            return c === ec;
          }
        });
      const shaHit = !!r.sha256 && !!e.sha256 && r.sha256.toLowerCase() === e.sha256.toLowerCase();
      const pathHit = toRelPosix(e.path) === toRelPosix(r.path);
      if (cidHit || shaHit || pathHit) targets.push(e);
    }
    // A tombstone for a path with no manifest entry still has to delete the bytes if they are sitting on
    // disk — the file may have been deleted from the manifest and left in the working tree.
    const rels = new Set<string>(targets.map((t) => t.path));
    rels.add(r.path);

    let bytes: "deleted" | "already-absent" | "kept" | "failed" = "already-absent";
    let pin: "unpinned" | "not-held" | "kept" | "failed" = "not-held";
    let sidecars = 0;
    let note: string | null = null;

    for (const rel of rels) {
      const abs = deps.resolveAbs(rel);
      if (abs === null) continue; // not placeable on this computer

      // 1 · working-tree bytes
      if (fs.existsSync(abs)) {
        if (!r.actions.delete_bytes) {
          bytes = "kept";
        } else {
          // BACKFILL IDENTITY WHILE WE HAVE IT (§7.3). This is the only moment the bytes are guaranteed to
          // be in hand, and content matching depends on having them. A tombstone that never saw the file
          // it names stays path-and-CID only, which is weaker.
          if (!r.sha256) {
            try {
              r.sha256 = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
              if (!out.touched.includes(r.path)) out.touched.push(r.path);
            } catch {
              /* identity backfill is best-effort; the delete is not */
            }
          }
          try {
            fs.rmSync(abs, { force: true });
            bytes = "deleted";
            out.bytesDeleted++;
          } catch (e) {
            bytes = "failed";
            note = (e as Error).message;
          }
        }
      }

      // 6 · derived sidecars. A TRANSCRIPTION OF A DELETED FILE IS STILL THE CONTENT OF THAT FILE — a
      // deletion that leaves a full text extraction of the image behind has not deleted anything that
      // matters. This is not tidiness (§7.2 step 6).
      if (r.actions.delete_bytes && deps.sidecarPathsFor) {
        for (const sc of deps.sidecarPathsFor(rel)) {
          try {
            if (fs.existsSync(sc)) {
              fs.rmSync(sc, { force: true });
              sidecars++;
              out.sidecarsRemoved++;
            }
          } catch {
            /* best-effort */
          }
        }
      }
    }

    // 2 · the IPFS pin
    for (const c of [r.cid, ...r.cid_alternates].filter(Boolean) as string[]) {
      if (!r.actions.unpin) {
        pin = "kept";
        break;
      }
      if (!deps.pinsetHasContent(c)) continue;
      try {
        await deps.pinRm(c);
        pin = "unpinned";
        out.unpinned++;
      } catch (e) {
        pin = "failed";
        note = note ?? (e as Error).message;
      }
    }

    // 3 + 4 · retract this device's claim, and mark the entry removed (never drop it — §7.2 step 4)
    for (const t of targets) {
      const had = t.pinned_by.includes(deps.label);
      if (had) t.pinned_by = t.pinned_by.filter((l) => l !== deps.label);
      if (t.state !== "removed") {
        t.state = "removed";
        out.entriesMarked++;
      }
      staled.push(t.path);
    }

    // 7.4 · the receipt. A device that enforced NOTHING because there was nothing here still records
    // `already-absent` — the receipt is evidence the device SAW the instruction, which is what makes
    // "is this really gone everywhere?" answerable instead of assumed.
    // A RECEIPT IS A HIGH-WATER MARK, NEVER A LIVE STATUS — and this is a churn bug, not a nicety.
    //
    // The pass that actually deletes records `bytes: deleted`. EVERY pass after it finds the file absent and
    // would compute `already-absent`, rewriting the receipt, re-serializing the ledger, and producing a
    // backbone commit — on every device, every fifteen minutes, forever. That is precisely the noise-commit
    // failure the manifest's byte-stable serializer exists to prevent, reached through a status field.
    //
    // It is also the more truthful record. "This computer deleted these bytes" stays true once it happens;
    // a later pass finding them absent CONFIRMS it rather than contradicting it, and "did this device carry
    // the deletion out?" is exactly the question the enforcement matrix (§7.5) asks. So a receipt is only
    // rewritten when the new outcome ranks HIGHER than the one already recorded — which also lets a `failed`
    // receipt be healed by a later pass that succeeds.
    const BYTES_RANK: Record<string, number> = { failed: 0, "already-absent": 1, kept: 1, deleted: 2 };
    const PIN_RANK: Record<string, number> = { failed: 0, "not-held": 1, kept: 1, unpinned: 2 };
    const prior = r.enforced_by.find((e) => e.device === deps.label);
    const improves =
      !prior ||
      (BYTES_RANK[bytes] ?? 0) > (BYTES_RANK[prior.bytes] ?? 0) ||
      (PIN_RANK[pin] ?? 0) > (PIN_RANK[prior.pin] ?? 0) ||
      sidecars > prior.sidecars;
    if (improves) {
      r.enforced_by = [...r.enforced_by.filter((e) => e.device !== deps.label), { device: deps.label, at: nowIso, bytes, pin, sidecars, note }];
      if (!out.touched.includes(r.path)) out.touched.push(r.path);
    }
  }

  // 5 · the decision ledger — stop the file sitting in the Undecided queue asking to be re-synced.
  if (staled.length > 0 && deps.tombstoneDecision) {
    try {
      await deps.tombstoneDecision([...new Set(staled)]);
    } catch (e) {
      log.warn("pin", `deletion: tombstoning decisions failed: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * EVERY place a derived artifact for `rel` could be sitting on THIS computer (deletion.mdx §7.2 step 6).
 *
 * Deliberately a UNION of all placements rather than a lookup of the configured one. Placement is a setting
 * that changes over time, and a file transcribed under one placement and deleted under another would leave
 * the old artifact behind — a full text extraction of the very image we just deleted. The cost of probing a
 * path that was never used is one `existsSync` that returns false; the cost of missing one is that the
 * deletion did not delete the thing that mattered.
 */
export function sidecarPathsForRepoRel(repoRoot: string, rel: string): string[] {
  const EXTS = [".transcription", ".ai_description", ".ai_description_rejected", ".ocr"];
  const roots: string[] = [];
  const local = resolveTrackingRoot(repoRoot);
  if (local) roots.push(local); //  ~/T/_large_files_bridge/repos/<key>/<rel><ext>
  const sync = resolveStateSyncRepo(repoRoot);
  if (sync) roots.push(sync); //    <syncRepo>/repos/<slug>-<uid>/<rel><ext>
  roots.push(path.join(repoRoot, ".lfbridge")); // in-repo quarantine mirror
  roots.push(repoRoot); //          beside the media
  const out: string[] = [];
  for (const r of roots) {
    const base = joinRelConfined(r, rel);
    if (base === null) continue;
    for (const ext of EXTS) out.push(base + ext);
    // The per-file record the tracking repo keeps for this path (`files/<rel>.yaml`) — it carries the
    // file's event history and must not outlive a fleet deletion either.
    const rec = joinRelConfined(path.join(r, "files"), rel);
    if (rec !== null) out.push(rec + ".yaml");
  }
  return out;
}
