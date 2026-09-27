// FLEET-DELETION LEDGER — the PURE half (parse, merge, serialize, meaning). A LEAF module on purpose.
//
// `deletions.service.ts` owns the reaper and the file plumbing; this file owns only functions of TEXT and
// VALUES, and imports nothing from the service graph. That is what lets the same code run in three places
// without a second implementation that could drift: the backend's event loop, the merge worker thread
// (merge-worker.ts), and the git merge driver process (git-merge-driver.ts) — the last two load this module
// cold and must not drag the whole app in with it.
import YAML from "yaml";
import { DeletionsSchema, type Deletions, type DeletionRecord } from "@lfb/shared";

export function emptyDeletions(): Deletions {
  return { schema_version: 1, unit: "repo", deletions: [] };
}

/** True if the raw text carries git merge-conflict markers (repo__list_syns.mdx §5.1). */
function hasConflictMarkers(raw: string): boolean {
  return /^(<{7}|={7}|>{7})(\s|$)/m.test(raw);
}

/**
 * Parse a ledger's TEXT. A HALF-MERGED file REFUSES to load, exactly as the manifest does. Parsing one would
 * be worse here than anywhere else in the product: the plausible failure is silently dropping records, and a
 * dropped tombstone puts a deleted file back on every computer. `file` only names the document in the error.
 */
export function parseDeletionsText(raw: string, file = "deletions.yaml"): Deletions {
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
    // A TOTAL order. Two records can share (path, removed_at) — before and after a sha256 backfill, or two
    // CIDs for one path — and a partial order left them in INPUT order, which differs between the mirror
    // leg (local first) and the reconcile leg (mirror first). Each leg then rewrote the other's bytes:
    // 218 commits a day on charlie-kirk's deletions.yaml with nothing changing (2026-09-27).
    deletions: [...d.deletions]
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          (a.removed_at ?? "").localeCompare(b.removed_at ?? "") ||
          (a.cid ?? "").localeCompare(b.cid ?? "") ||
          (a.sha256 ?? "").localeCompare(b.sha256 ?? ""),
      )
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
        // Writer provenance (backward_compatibility.md §3) — present only when the record carries it, so a
        // record from a legacy writer serializes exactly as that writer spelled it.
        ...(r.writer_build !== undefined ? { writer_build: r.writer_build } : {}),
        ...(r.writer_device !== undefined ? { writer_device: r.writer_device } : {}),
      })),
  });
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
  // A BACKFILLED sha256 IS NOT A NEW TOMBSTONE. `reap` fills in `sha256` the first time it holds the bytes
  // (§7.3), which changes the record's identity key — so the device that backfilled carried (path, cid, X)
  // while every other copy still carried (path, cid, null), and the union kept BOTH forever (131 twin pairs
  // on charlie-kirk). A null-sha record folds into its twin when exactly one sha is known for that
  // (path, cid); two genuinely different shas stay two records.
  const shasByPathCid = new Map<string, Set<string>>();
  for (const r of [...mine.deletions, ...theirs.deletions]) {
    if (!r.sha256) continue;
    const pc = `${r.path}\u0000${r.cid ?? ""}`;
    const s = shasByPathCid.get(pc) ?? new Set<string>();
    s.add(r.sha256);
    shasByPathCid.set(pc, s);
  }
  const keyFor = (r: DeletionRecord): string => {
    if (r.sha256) return identityKey(r);
    const known = shasByPathCid.get(`${r.path}\u0000${r.cid ?? ""}`);
    return known && known.size === 1 ? identityKey({ ...r, sha256: [...known][0] }) : identityKey(r);
  };
  const by = new Map<string, DeletionRecord>();
  for (const r of [...mine.deletions, ...theirs.deletions]) {
    const k = keyFor(r);
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

/**
 * THE MEANING of a deletion ledger — what every reader enforces, and nothing else (backward_compatibility.md
 * §4.2). Twins are folded (a merge with nothing), the order is the serializer's total order, and WRITER STAMPS
 * are removed: an older build strips them when it re-serializes, and a shared copy must never be rewritten
 * just to put a stamp back — that is a tug-of-war the old build wins every time, one commit per pass.
 */
export function deletionsMeaning(d: Deletions): string {
  const folded = mergeDeletions(d, emptyDeletions());
  return serializeDeletions({
    ...folded,
    deletions: folded.deletions.map(({ writer_build: _b, writer_device: _d, ...r }) => ({
      ...r,
      enforced_by: r.enforced_by.map(({ writer_build: _rb, ...e }) => e),
    })),
  });
}
