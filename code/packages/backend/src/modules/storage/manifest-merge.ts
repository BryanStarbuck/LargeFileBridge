// The per-entry manifest MERGE (storage_company.mdx §8.4.3) — a LEAF module (types + pure functions only).
//
// It lives apart from tracking-sync.service.ts because both the WRITE path (reconciling a pulled sync-repo
// subtree) and the READ path (units.service folding the unit and tracking manifests for the file rows) need
// it, and units.service cannot import tracking-sync.service without an import cycle.
import type { Manifest, ManifestFile } from "@lfb/shared";

/**
 * Merge an incoming manifest into the local one (storage_company.mdx §8.4.3). An arriving manifest is a set
 * of CLAIMS from another computer, never ground truth (sync_list.mdx §5), so this is a per-entry MERGE:
 *
 *   • **union by `path`** — an entry on either side survives;
 *   • **union `pinned_by`** — the two computers' pin claims ADD. This is the load-bearing one: a
 *     last-writer copy erases the peer's claim, and the peer's claim IS the "a computer of yours has this"
 *     signal the whole pull-down feature reads;
 *   • **absence is NEVER a delete** — a path missing from the incoming copy keeps its local entry;
 *   • a **CID conflict** on the same path resolves to the newer `modified_at` (ties keep local).
 *
 * This computer's own `pinned_by` claim is NOT trusted from the wire — the pin pass re-derives it from the
 * real local pinset every run, so a peer's manifest can never make this machine believe it holds bytes it
 * does not (ipfs.mdx §1.1).
 */
export function mergeManifests(local: Manifest, incoming: Manifest): Manifest {
  const byPath = new Map<string, ManifestFile>(local.files.map((f) => [f.path, { ...f }]));
  for (const inc of incoming.files) {
    const cur = byPath.get(inc.path);
    if (!cur) {
      byPath.set(inc.path, { ...inc });
      continue;
    }
    const incNewer = (inc.modified_at ?? "") > (cur.modified_at ?? "");
    byPath.set(inc.path, {
      ...cur,
      // A conflicting CID resolves by recency; an absent side never wins over a present one.
      cid: cur.cid && inc.cid && cur.cid !== inc.cid ? (incNewer ? inc.cid : cur.cid) : (cur.cid ?? inc.cid),
      size: incNewer ? (inc.size ?? cur.size) : cur.size,
      sha256: cur.sha256 ?? inc.sha256,
      modified_at: incNewer ? inc.modified_at : cur.modified_at,
      pinned_by: [...new Set([...(cur.pinned_by ?? []), ...(inc.pinned_by ?? [])])].sort((a, b) => a.localeCompare(b)),
    });
  }
  return {
    ...local,
    files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

