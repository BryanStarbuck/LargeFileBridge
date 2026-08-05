// Everything that makes a manifest ADDITIVE, in one LEAF module (pure functions, no app state): the
// duplicate FOLD, the per-entry MERGE (storage_company.mdx §8.4.3), and the canonical SERIALIZATION.
//
// It lives apart from tracking-sync.service.ts because both the WRITE path (reconciling a pulled sync-repo
// subtree) and the READ path (units.service folding the unit and tracking manifests for the file rows) need
// it, and units.service cannot import tracking-sync.service without an import cycle. Every other module that
// reads or writes a manifest routes through here, which is the point: the ways this file's entries have
// actually been lost were all "some caller did its own thing" — a bare Map, a bare YAML.stringify, a
// wholesale copy.
import YAML from "yaml";
import type { Manifest, ManifestFile } from "@lfb/shared";
import { healWindowsPath } from "../../shared/rel-path.js";

/**
 * Fold a file list so ONE path appears ONCE, unioning what the duplicates knew.
 *
 * Duplicates are the NORMAL output of the backbone, not a corruption: `manifest.yaml` carries
 * `merge=union` (git_backbone.mdx §4.2), so a conflicting merge CONCATENATES both sides and the file
 * legitimately holds the same `- path:` twice. Measured on the live `all` repo's mirror: 27 of 92 commits
 * held 29 entry blocks for 19 distinct paths.
 *
 * Every reader used to collapse that with `new Map(files.map((f) => [f.path, f]))` — LAST OCCURRENCE WINS,
 * silently discarding whichever twin held the CID or the peer's pin claim. That is a delete disguised as a
 * read: `mergeManifests` promises "absence is never a delete", then loses a claim before the merge even
 * starts. Folding unions instead — the same rule the `\`-vs-`/` collision already used.
 *
 * `unit === "computer"` keys on ABSOLUTE paths, where `C:\Users\…` is a legitimate value, so separators are
 * left alone there (repo__list_syns.mdx §6.1 is about repo-relative keys).
 */
export function foldManifestFiles(files: ManifestFile[], unit: Manifest["unit"]): ManifestFile[] {
  const heal = unit !== "computer";
  const byPath = new Map<string, ManifestFile>();
  for (const f of files) {
    const p = heal ? healWindowsPath(f.path) : f.path;
    const prev = byPath.get(p);
    if (!prev) {
      byPath.set(p, { ...f, path: p });
      continue;
    }
    // Prefer the twin that knows more (has a CID; else the newer modified_at), and union the device claims
    // so no computer's "I hold this" is dropped by the fold.
    const incWins = (!!f.cid && !prev.cid) || (!!f.cid === !!prev.cid && (f.modified_at ?? "") > (prev.modified_at ?? ""));
    byPath.set(p, {
      ...(incWins ? f : prev),
      path: p,
      sha256: prev.sha256 ?? f.sha256,
      pinned_by: [...new Set([...prev.pinned_by, ...f.pinned_by])],
    });
  }
  return [...byPath.values()];
}

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
  // FOLD EACH SIDE FIRST. Either side may legitimately carry the same path twice (a `merge=union` git
  // merge concatenates both), and keying a raw list into a Map is last-wins — the twin that held the CID
  // or the peer's claim would be dropped before this function's own union rules ever ran.
  const byPath = new Map<string, ManifestFile>(foldManifestFiles(local.files, local.unit).map((f) => [f.path, f]));
  for (const inc of foldManifestFiles(incoming.files, incoming.unit)) {
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

/**
 * The ONE canonical, byte-stable serialization of a manifest (repo__list_syns.mdx §6): entries sorted by
 * `path`, stable key order, `pinned_by` sorted, POSIX separators, no volatile timestamp — so an unchanged
 * list re-serializes byte-identically and produces no commit.
 *
 * It lives in this leaf so EVERY writer shares it. It used to be private to manifest.service.ts, which meant
 * the two writers that cannot import that module — the sync-repo mirror and the reconcile — wrote the same
 * document with a plain `YAML.stringify`. Two spellings of one file is churn by construction: each writer
 * re-dirtied what the other had just written, and every one of those diffs became a backbone commit.
 */
export function serializeManifest(manifest: Manifest): string {
  return YAML.stringify({
    schema_version: manifest.schema_version,
    unit: manifest.unit,
    files: foldManifestFiles(manifest.files, manifest.unit)
      .map((f) => ({
        path: f.path,
        cid: f.cid,
        size: f.size,
        sha256: f.sha256,
        modified_at: f.modified_at,
        pinned_by: [...f.pinned_by].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
}

